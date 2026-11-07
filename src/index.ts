import {
  type OAuthAuthorizationServer,
  OAuthResourceServer
} from "@cloudflare/workers-oauth-provider";
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
import {
  createAuthorizationServer,
  isMcpRoute,
  type McpRoute,
  mcpResource
} from "./oauth-server";

export { ThoughtStore } from "./thought-store";

const CORS_HEADERS = {
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID, traceparent, tracestate, baggage",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "MCP-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400"
} as const;

// Browser-hosted MCP clients send an Origin header from their own application
// domain. Keep the default narrow while allowing the two supported web hosts;
// operators can still replace it entirely with ALLOWED_ORIGIN_HOSTNAMES.
const HOSTED_MCP_CLIENT_ORIGINS = [
  "claude.ai",
  "www.claude.ai",
  "claude.com",
  "www.claude.com",
  "chatgpt.com",
  "www.chatgpt.com",
  "chat.openai.com"
] as const;

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
    configuredOrigins ?? [
      ...localhostAllowedOrigins(),
      url.hostname,
      ...HOSTED_MCP_CLIENT_ORIGINS
    ];
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
        version: "3.2.0",
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

type OAuthRoles = {
  authorizationServer: OAuthAuthorizationServer<WorkerEnv>;
  resourceServers: Record<McpRoute, OAuthResourceServer<WorkerEnv>>;
};

// Each MCP route advertises metadata whose `resource` is the exact
// client-entered URL. Resources are built from the request origin, as 0.x
// derived them, so production (workers.dev), `wrangler dev` and tests each
// advertise their own URLs. Cloudflare routes requests to this Worker by
// hostname, so the set of origins is small; the cache is capped anyway.
const oauthRolesByOrigin = new Map<string, OAuthRoles>();
const MAX_CACHED_ORIGINS = 8;

function oauthRoles(requestUrl: URL): OAuthRoles {
  const origin = requestUrl.origin;
  const cached = oauthRolesByOrigin.get(origin);
  if (cached) return cached;

  const authorizationServer = createAuthorizationServer(origin);
  const resourceServer = (route: McpRoute) =>
    new OAuthResourceServer<WorkerEnv>({
      resourceMetadata: {
        resource: mcpResource(origin, route),
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
        resource_name: "Durable Thinking MCP"
      },
      validateToken: (env) => (resource, token) =>
        authorizationServer.validateToken(resource, token, env),
      handler: mcpApiHandler
    });

  const roles: OAuthRoles = {
    authorizationServer,
    resourceServers: {
      "/mcp": resourceServer("/mcp"),
      "/mcp-compat": resourceServer("/mcp-compat")
    }
  };
  if (oauthRolesByOrigin.size < MAX_CACHED_ORIGINS) oauthRolesByOrigin.set(origin, roles);
  return roles;
}

const PROTECTED_RESOURCE_METADATA_PREFIX = "/.well-known/oauth-protected-resource";

const TOKEN_GRANT_PROPAGATION_RETRY_DELAYS_MS = [0, 200, 400, 800, 1600];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGrantPropagationDelay(body: unknown): boolean {
  return (
    isRecord(body) &&
    body.error === "invalid_grant" &&
    typeof body.error_description === "string" &&
    body.error_description.startsWith("Grant not found")
  );
}

// workers-oauth-provider (0.10 and 1.x) stores the authorization-code/refresh-token
// grant in Workers KV and reads it back by key at /token — no retry, no
// alternate consistency mode (the library's own draft storage-provider RFC,
// cloudflare/workers-oauth-provider#237, documents that KV "explicitly
// advertises eventual reads"; it is not merged/released). The grant is
// written during /callback, which runs on a Cloudflare colo near the user's
// browser; a hosted client's backend calls /token from its own infrastructure,
// which commonly lands on a *different* colo. A `grantData == null` on
// that read surfaces as `invalid_grant` / "Grant not found or authorization
// code expired" (or, for refresh, "Grant not found") even though the grant
// exists and nothing has been consumed yet — the same propagation-delay
// failure mode that caused our own flow-state "state_not_found" bug (see
// oauth.ts). Retrying is safe: the not-found path never mutates the grant,
// so replaying the same request just gives KV replication time to catch up.
async function fetchTokenEndpoint(
  authorizationServer: OAuthAuthorizationServer<WorkerEnv>,
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext
): Promise<Response> {
  const bodyText = await request.text();
  let response: Response | undefined;
  for (const delay of TOKEN_GRANT_PROPAGATION_RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const attemptRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: bodyText
    });
    response = await authorizationServer.fetch(attemptRequest, env, ctx);
    if (response.status !== 400) return response;
    let parsedBody: unknown;
    try {
      parsedBody = await response.clone().json();
    } catch {
      return response;
    }
    if (!isGrantPropagationDelay(parsedBody)) return response;
    console.error(JSON.stringify({ event: "oauth_token_grant_propagation_retry", delay }));
  }
  console.error(JSON.stringify({ event: "oauth_token_grant_propagation_exhausted" }));
  return response!;
}

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (isMcpRoute(pathname)) {
      const staticAuth = await authenticate(request, env);
      if (staticAuth.ok || request.method === "OPTIONS") {
        return mcpApiHandler.fetch(request, env);
      }
      return oauthRoles(url).resourceServers[pathname].fetch(request, env, ctx);
    }

    // Keep the original exact-route 404 behavior for lookalike paths such as
    // /mcp-other.
    if (pathname.startsWith("/mcp")) {
      return publicHandler.fetch(request, env, ctx);
    }

    const roles = oauthRoles(url);

    if (pathname.startsWith(PROTECTED_RESOURCE_METADATA_PREFIX)) {
      const route = pathname.slice(PROTECTED_RESOURCE_METADATA_PREFIX.length);
      return isMcpRoute(route)
        ? roles.resourceServers[route].fetch(request, env, ctx)
        : withCorsAndSecurity(json({ error: "Not found" }, 404));
    }

    if (pathname === "/authorize" || pathname === "/callback") {
      const oauthEnv: WorkerEnv = {
        ...env,
        OAUTH_PROVIDER: roles.authorizationServer.getOAuthApi(env)
      };
      return publicHandler.fetch(request, oauthEnv, ctx);
    }

    if (pathname === "/token" && request.method === "POST") {
      return fetchTokenEndpoint(roles.authorizationServer, request, env, ctx);
    }

    const response = await roles.authorizationServer.fetch(request, env, ctx);
    return response.status === 404 ? publicHandler.fetch(request, env, ctx) : response;
  }
} satisfies ExportedHandler<WorkerEnv>;
