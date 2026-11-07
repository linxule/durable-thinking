import { OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
import type { WorkerEnv } from "./config";

export const MCP_ROUTES = ["/mcp", "/mcp-compat"] as const;
export type McpRoute = (typeof MCP_ROUTES)[number];

export function isMcpRoute(pathname: string): pathname is McpRoute {
  return (MCP_ROUTES as readonly string[]).includes(pathname);
}

export function mcpResource(origin: string, route: McpRoute): string {
  return `${origin}${route}`;
}

// workers-oauth-provider 1.x binds every grant and token to one canonical
// resource. /mcp and /mcp-compat are distinct protected resources, so the
// authorization server declares both and each route is hosted by its own
// resource server (src/index.ts). A token is accepted only on the route its
// audience names, matching 0.x's path-boundary audience check. Clients that
// omit `resource` get /mcp-compat, the documented connection URL.
export function createAuthorizationServer(origin: string): OAuthAuthorizationServer<WorkerEnv> {
  return new OAuthAuthorizationServer<WorkerEnv>({
    issuer: origin,
    resources: MCP_ROUTES.map((route) => mcpResource(origin, route)),
    defaultResource: mcpResource(origin, "/mcp-compat"),
    legacyGrantResource: mcpResource(origin, "/mcp-compat"),
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    onError({ status, code, internal }) {
      // Keep diagnostics to protocol codes and the provider's structured reason
      // tags. Never log descriptions, headers, or requests: those can carry
      // attacker-controlled text or credentials.
      console.error(
        JSON.stringify({
          event: "oauth_provider_error",
          status,
          code,
          internalCategory: internal?.category,
          internalReason: internal?.reason
        })
      );
    }
  });
}
