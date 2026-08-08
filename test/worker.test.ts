import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { WorkerEnv } from "../src/config";
import worker from "../src/index";

const workerEnv = env as unknown as WorkerEnv;
const token = "test-token-0123456789abcdef0123456789abcdef";

async function fetch(request: Request): Promise<Response> {
  // worker.fetch is called directly, so the Host header the Cloudflare edge
  // would normally set must be supplied explicitly for host validation.
  const headers = new Headers(request.headers);
  if (!headers.has("host")) headers.set("host", new URL(request.url).host);
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(request, { headers }), workerEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("Worker routes", () => {
  it("describes the persistent server at the root", async () => {
    const response = await fetch(new Request("https://example.com/"));
    const body = (await response.json()) as { persistence: string; interface: string; tools: string[] };

    expect(response.status).toBe(200);
    expect(body.persistence).toContain("Durable Object");
    expect(body.interface).toContain("MCP Apps");
    expect(body.tools).toEqual([
      "sequentialthinking",
      "get_thought_history",
      "delete_thought_sequence"
    ]);
  });

  it("reports shallow and authenticated deep storage health", async () => {
    const shallow = await fetch(new Request("https://example.com/healthz"));
    expect(shallow.status).toBe(200);

    const deep = await fetch(
      new Request("https://example.com/healthz?deep=1", {
        headers: { Authorization: `Bearer ${token}` }
      })
    );
    const body = (await deep.json()) as {
      ok: boolean;
      deepChecked: boolean;
      schemaVersion: number;
    };

    expect(deep.status).toBe(200);
    expect(body).toMatchObject({ ok: true, deepChecked: true, schemaVersion: 3 });
  });

  it("protects the deep storage health check", async () => {
    const response = await fetch(new Request("https://example.com/healthz?deep=1"));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("answers an allowed MCP browser preflight without requiring authentication", async () => {
    const response = await fetch(
      new Request("https://example.com/mcp", {
        method: "OPTIONS",
        headers: {
          Origin: "https://example.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers":
            "authorization, content-type, mcp-protocol-version, mcp-method, mcp-name"
        }
      })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Mcp-Method");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Mcp-Name");
  });

  it("rejects a browser Origin outside the configured allowlist", async () => {
    const response = await fetch(
      new Request("https://example.com/mcp", {
        method: "OPTIONS",
        headers: {
          Origin: "https://untrusted.example",
          "Access-Control-Request-Method": "POST"
        }
      })
    );

    expect(response.status).toBe(403);
  });

  it("rejects unauthenticated MCP requests", async () => {
    const response = await fetch(
      new Request("https://example.com/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://example.com/.well-known/oauth-protected-resource"'
    );
  });

  it("keeps the static bearer fast path working", async () => {
    // /mcp-compat speaks plain 2025-era JSON-RPC; strict /mcp requires the
    // 2026-07-28 envelope. The static fast path covers both routes identically.
    const response = await fetch(
      new Request("https://example.com/mcp-compat", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "vitest", version: "1.0.0" }
          }
        })
      })
    );
    expect(response.status).toBe(200);

    // Streamable HTTP answers with SSE framing; the payload is the data line.
    const raw = await response.text();
    const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
    expect(dataLine).toBeDefined();
    const body = JSON.parse(dataLine!.slice("data:".length)) as {
      result?: { serverInfo?: { version?: string } };
    };
    expect(body.result?.serverInfo?.version).toBe("3.1.0");
  });

  it("serves OAuth protected-resource metadata", async () => {
    const response = await fetch(
      new Request("https://example.com/.well-known/oauth-protected-resource")
    );
    const body = (await response.json()) as {
      resource?: string;
      authorization_servers?: string[];
    };

    expect(response.status).toBe(200);
    expect(body.resource).toBe("https://example.com");
    expect(body.authorization_servers).toEqual(["https://example.com"]);
  });

  it("serves OAuth authorization-server metadata with DCR", async () => {
    const response = await fetch(
      new Request("https://example.com/.well-known/oauth-authorization-server")
    );
    const body = (await response.json()) as {
      authorization_endpoint?: string;
      token_endpoint?: string;
      registration_endpoint?: string;
    };

    expect(response.status).toBe(200);
    expect(body.authorization_endpoint).toBe("https://example.com/authorize");
    expect(body.token_endpoint).toBe("https://example.com/token");
    expect(body.registration_endpoint).toBe("https://example.com/register");
  });

  it("rejects a garbage bearer token without an internal error", async () => {
    const response = await fetch(
      new Request("https://example.com/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer definitely-not-a-valid-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });
});
