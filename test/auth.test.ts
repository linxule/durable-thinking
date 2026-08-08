import { describe, expect, it } from "vitest";
import { authenticate } from "../src/auth";
import { isAllowedGitHubLogin } from "../src/oauth";

const token = "a".repeat(64);

function request(authorization?: string): Request {
  return new Request("https://example.com/mcp", {
    method: "POST",
    ...(authorization ? { headers: { Authorization: authorization } } : {})
  });
}

describe("bearer authentication", () => {
  it("accepts a matching bearer token and uses the single personal store", async () => {
    const result = await authenticate(request(`Bearer ${token}`), {
      MCP_API_TOKEN: token
    });

    expect(result).toEqual({ ok: true });
  });

  it("rejects missing and incorrect tokens", async () => {
    const missing = await authenticate(request(), { MCP_API_TOKEN: token });
    const incorrect = await authenticate(request(`Bearer ${"b".repeat(64)}`), {
      MCP_API_TOKEN: token
    });

    expect(missing).toMatchObject({ ok: false, status: 401 });
    expect(incorrect).toMatchObject({ ok: false, status: 401 });
  });

  it("fails closed when no strong secret is configured", async () => {
    const result = await authenticate(request("Bearer short"), {
      MCP_API_TOKEN: "short"
    });

    expect(result).toMatchObject({ ok: false, status: 503 });
  });
});

describe("GitHub login allowlist", () => {
  it("accepts an exact login", () => {
    expect(isAllowedGitHubLogin("linxule", "linxule")).toBe(true);
    expect(isAllowedGitHubLogin("linxule", "linxule-extra")).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(isAllowedGitHubLogin("LinXule", "linxule")).toBe(true);
  });

  it("accepts any matching entry in a comma-separated list", () => {
    expect(isAllowedGitHubLogin("linxule", "first-user, linxule, third-user")).toBe(true);
  });

  it("rejects everyone when the allowlist is empty or missing", () => {
    expect(isAllowedGitHubLogin("linxule", "")).toBe(false);
    expect(isAllowedGitHubLogin("linxule", undefined)).toBe(false);
  });
});
