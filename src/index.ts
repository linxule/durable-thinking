import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  type CreateMcpHandlerOptions
} from "@modelcontextprotocol/server";
import { authenticate } from "./auth";
import {
  csv,
  hasStrongSecret,
  thoughtRetentionDays,
  type WorkerEnv
} from "./config";
import { createSequentialThinkingServer } from "./server";
import { getThoughtStore } from "./store-client";
import { githubOAuthResponse } from "./oauth";

export { ThoughtStore } from "./thought-store";

const CORS_HEADERS = {
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID, traceparent, tracestate, baggage",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "MCP-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400"
} as const;

function json(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body, null, 2), { status, headers });
}

function withCorsAndSecurity(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.append("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function authenticationFailure(status: 401 | 503, message: string): Response {
  const headers = new Headers();
  if (status === 401) {
    headers.set("WWW-Authenticate", 'Bearer realm="sequential-thinking-mcp"');
  }
  return withCorsAndSecurity(json({ error: message }, status, headers));
}

function mcpHandlerOptions(legacy: "reject" | "stateless"): CreateMcpHandlerOptions {
  return {
    legacy,
    onerror(error) {
      console.error(
        JSON.stringify({ event: "mcp_handler_error", name: error.name, message: error.message })
      );
    }
  };
}

function requestValidationResponse(request: Request, env: WorkerEnv): Response | undefined {
  const url = new URL(request.url);
  const configuredHosts = csv(env.ALLOWED_HOSTNAMES);
  const isLocal = localhostAllowedHostnames().includes(url.hostname);
  const isWorkersDev = url.hostname.endsWith(".workers.dev");
  const allowedHosts =
    configuredHosts ??
    (isLocal ? localhostAllowedHostnames() : isWorkersDev ? [url.hostname] : undefined);
  const hostFailure = allowedHosts
    ? hostHeaderValidationResponse(request, allowedHosts)
    : undefined;
  if (hostFailure) return withCorsAndSecurity(hostFailure);

  const configuredOrigins = csv(env.ALLOWED_ORIGIN_HOSTNAMES);
  const allowedOrigins =
    configuredOrigins ?? [...localhostAllowedOrigins(), url.hostname];
  const originFailure = originValidationResponse(request, allowedOrigins);
  return originFailure ? withCorsAndSecurity(originFailure) : undefined;
}

const publicHandler = {
  async fetch(
    request: Request,
    env: WorkerEnv,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      const body = {
        name: "Persistent Sequential Thinking MCP",
        version: "3.1.0",
        protocol: "MCP 2026-07-28 stateless HTTP",
        persistence: "SQLite-backed Cloudflare Durable Object",
        continuity: "Explicit sequenceId tool argument — the unguessable ID is the capability that scopes a sequence to its conversation",
        interface: "MCP Apps 2026-01-26 per-thought cards with a final process timeline, text fallback",
        tools: [
          "sequentialthinking",
          "get_thought_history",
          "delete_thought_sequence"
        ],
        endpoints: {
          strict: "/mcp",
          compatibility: "/mcp-compat",
          health: "/healthz"
        },
        authentication: "GitHub OAuth or bearer token"
      };
      return withCorsAndSecurity(
        request.method === "HEAD" ? new Response(null, { status: 200 }) : json(body)
      );
    }

    if (url.pathname === "/healthz") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return withCorsAndSecurity(json({ error: "Method not allowed" }, 405));
      }

      const authConfigured = hasStrongSecret(env.MCP_API_TOKEN);
      const storageBindingConfigured = Boolean(env.THOUGHT_STORE);
      const healthy = authConfigured && storageBindingConfigured;
      const base = {
        ok: healthy,
        authentication: "Bearer token",
        authConfigured,
        storageBindingConfigured,
        thoughtRetentionDays: thoughtRetentionDays(env),
        deepChecked: false
      };

      if (url.searchParams.get("deep") !== "1") {
        return withCorsAndSecurity(
          request.method === "HEAD"
            ? new Response(null, { status: healthy ? 200 : 503 })
            : json(base, healthy ? 200 : 503)
        );
      }

      const auth = await authenticate(request, env);
      if (!auth.ok) return authenticationFailure(auth.status, auth.message);

      try {
        const storage = await getThoughtStore(env).ping();
        const body = {
          ...base,
          ok: true,
          deepChecked: true,
          schemaVersion: storage.schemaVersion
        };
        return withCorsAndSecurity(
          request.method === "HEAD" ? new Response(null, { status: 200 }) : json(body)
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "thought_store_health_error",
            message: error instanceof Error ? error.message : String(error)
          })
        );
        return withCorsAndSecurity(
          request.method === "HEAD"
            ? new Response(null, { status: 503 })
            : json(
                {
                  ...base,
                  ok: false,
                  deepChecked: true,
                  error: "The Durable Object storage health check failed."
                },
                503
              )
        );
      }
    }

    const oauthResponse = await githubOAuthResponse(request, env);
    if (oauthResponse) return oauthResponse;

    return withCorsAndSecurity(json({ error: "Not found" }, 404));
  }
} satisfies ExportedHandler<WorkerEnv>;

const mcpApiHandler = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp" && url.pathname !== "/mcp-compat") {
      return withCorsAndSecurity(json({ error: "Not found" }, 404));
    }

    const validationFailure = requestValidationResponse(request, env);
    if (validationFailure) return validationFailure;

    if (request.method === "OPTIONS") {
      return withCorsAndSecurity(new Response(null, { status: 204 }));
    }

    const legacy = url.pathname === "/mcp" ? "reject" : "stateless";
    const handler = createMcpHandler(
      () => createSequentialThinkingServer(env),
      mcpHandlerOptions(legacy)
    );
    return withCorsAndSecurity(await handler.fetch(request));
  }
} satisfies ExportedHandler<WorkerEnv>;

const oauthProvider = new OAuthProvider<WorkerEnv>({
  apiRoute: ["/mcp", "/mcp-compat"],
  apiHandler: mcpApiHandler,
  defaultHandler: publicHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  allowPlainPKCE: false,
  allowImplicitFlow: false,
  resourceMetadata: {
    bearer_methods_supported: ["header"],
    resource_name: "Durable Thinking MCP"
  },
  onError: () => undefined
});

function withCanonicalResourceMetadataChallenge(
  request: Request,
  response: Response
): Response {
  if (response.status !== 401) return response;
  const challenge = response.headers.get("WWW-Authenticate");
  if (!challenge) return response;

  const resourceMetadata = `${new URL(request.url).origin}/.well-known/oauth-protected-resource`;
  const headers = new Headers(response.headers);
  headers.set(
    "WWW-Authenticate",
    challenge.replace(/resource_metadata="[^"]*"/u, `resource_metadata="${resourceMetadata}"`)
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContext
  ): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const isMcpRequest = pathname === "/mcp" || pathname === "/mcp-compat";

    if (isMcpRequest) {
      const staticAuth = await authenticate(request, env);
      if (staticAuth.ok || request.method === "OPTIONS") {
        return mcpApiHandler.fetch(request, env);
      }
    }

    // OAuthProvider treats apiRoute values as prefixes. Keep the original
    // exact-route 404 behavior for lookalike paths such as /mcp-other.
    if (!isMcpRequest && pathname.startsWith("/mcp")) {
      return publicHandler.fetch(request, env, ctx);
    }

    const response = await oauthProvider.fetch(request, env, ctx);
    return isMcpRequest
      ? withCanonicalResourceMetadataChallenge(request, response)
      : response;
  }
} satisfies ExportedHandler<WorkerEnv>;
