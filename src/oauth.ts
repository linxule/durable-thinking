import {
  AuthorizationError,
  type AuthRequest,
  type ClientInfo
} from "@cloudflare/workers-oauth-provider";
import type { WorkerEnv } from "./config";

const FLOW_TTL_SECONDS = 10 * 60;
const CONSENT_STATE_PREFIX = "github-consent:";
const CALLBACK_STATE_PREFIX = "github-callback:";
const STATE_COOKIE = "__Host-durable-thinking-oauth-state";

type StoredFlow = {
  oauthRequest: AuthRequest;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthRequest(value: unknown): value is AuthRequest {
  if (!isRecord(value)) return false;
  return (
    typeof value.responseType === "string" &&
    typeof value.clientId === "string" &&
    typeof value.redirectUri === "string" &&
    Array.isArray(value.scope) &&
    value.scope.every((scope) => typeof scope === "string") &&
    typeof value.state === "string"
  );
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlResponse(body: string, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(body, { status, headers });
}

function errorPage(status: number, title: string, message: string): Response {
  return htmlResponse(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${htmlEscape(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1.25rem;color:#17202a}h1{font-size:1.5rem}</style><main><h1>${htmlEscape(title)}</h1><p>${htmlEscape(message)}</p></main></html>`,
    status
  );
}

function consentPage(client: ClientInfo, stateToken: string): Response {
  const clientName = client.clientName?.trim() || "An MCP client";
  return htmlResponse(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize Durable Thinking</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#f6f7f9;color:#17202a;margin:0}.card{max-width:34rem;margin:8vh auto;background:white;border:1px solid #d8dde3;border-radius:14px;padding:2rem;box-shadow:0 8px 28px #17202a14}h1{font-size:1.5rem;margin-top:0}.actions{display:flex;gap:.75rem;margin-top:1.5rem}button{font:inherit;border-radius:8px;padding:.65rem 1rem;border:1px solid #aeb6bf;background:white;cursor:pointer}.primary{background:#17202a;color:white;border-color:#17202a}</style><main class="card"><h1>Connect Durable Thinking</h1><p><strong>${htmlEscape(clientName)}</strong> wants to connect to this private MCP server.</p><p>Continue to GitHub to verify that your account is on the server allowlist. Durable Thinking will read only your GitHub account identity and will not retain the GitHub access token.</p><form method="post" action="/authorize"><input type="hidden" name="state" value="${htmlEscape(stateToken)}"><div class="actions"><button class="primary" type="submit" name="decision" value="approve">Continue with GitHub</button><button type="submit" name="decision" value="deny">Cancel</button></div></form></main></html>`,
    200,
    { "Set-Cookie": stateCookie(stateToken) }
  );
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function stateCookie(value: string): string {
  return `${STATE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${FLOW_TTL_SECONDS}`;
}

function clearStateCookie(): string {
  return `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function cookieValue(request: Request, name: string): string | undefined {
  for (const item of request.headers.get("Cookie")?.split(";") ?? []) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      return item.slice(separator + 1).trim() || undefined;
    }
  }
  return undefined;
}

function withClearedStateCookie(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", clearStateCookie());
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function oauthHelpers(env: WorkerEnv) {
  if (!env.OAUTH_PROVIDER) throw new Error("OAuth provider helpers are unavailable.");
  return env.OAUTH_PROVIDER;
}

async function storeFlow(
  env: WorkerEnv,
  prefix: string,
  oauthRequest: AuthRequest
): Promise<string> {
  const stateToken = randomToken();
  await env.OAUTH_KV.put(
    `${prefix}${stateToken}`,
    JSON.stringify({ oauthRequest } satisfies StoredFlow),
    { expirationTtl: FLOW_TTL_SECONDS }
  );
  return stateToken;
}

async function takeFlow(
  request: Request,
  env: WorkerEnv,
  prefix: string,
  stateToken: string | null
): Promise<AuthRequest | undefined> {
  if (!stateToken || !/^[A-Za-z0-9_-]{43}$/u.test(stateToken)) return undefined;
  if (cookieValue(request, STATE_COOKIE) !== stateToken) return undefined;

  const key = `${prefix}${stateToken}`;
  const stored = await env.OAUTH_KV.get<StoredFlow>(key, { type: "json" });
  if (!stored || !isAuthRequest(stored.oauthRequest)) return undefined;
  await env.OAUTH_KV.delete(key);
  return stored.oauthRequest;
}

function oauthErrorRedirect(
  oauthRequest: AuthRequest,
  code: "access_denied" | "server_error",
  description: string
): Response {
  const redirect = new URL(oauthRequest.redirectUri);
  redirect.searchParams.set("error", code);
  redirect.searchParams.set("error_description", description);
  redirect.searchParams.set("state", oauthRequest.state);
  if (oauthRequest.issuer) redirect.searchParams.set("iss", oauthRequest.issuer);
  return Response.redirect(redirect.toString(), 302);
}

function authorizationErrorResponse(error: unknown): Response {
  if (!(error instanceof AuthorizationError)) {
    return errorPage(500, "Authorization failed", "The authorization request could not be processed.");
  }
  if (!error.redirectUri) {
    return errorPage(400, "Invalid authorization request", error.description);
  }
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect.toString(), 302);
}

function githubConfigured(env: WorkerEnv): boolean {
  return Boolean(env.GITHUB_CLIENT_ID?.trim() && env.GITHUB_CLIENT_SECRET?.trim());
}

function githubAuthorizeResponse(request: Request, env: WorkerEnv, stateToken: string): Response {
  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID!.trim());
  authorizeUrl.searchParams.set("redirect_uri", new URL("/callback", request.url).toString());
  authorizeUrl.searchParams.set("scope", "read:user");
  authorizeUrl.searchParams.set("state", stateToken);
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl.toString(),
      "Set-Cookie": stateCookie(stateToken),
      "Cache-Control": "no-store"
    }
  });
}

async function githubAccessToken(request: Request, env: WorkerEnv, code: string): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "durable-thinking/3.1.0"
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID!.trim(),
      client_secret: env.GITHUB_CLIENT_SECRET!.trim(),
      code,
      redirect_uri: new URL("/callback", request.url).toString()
    })
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(body) || typeof body.access_token !== "string") {
    throw new Error("GitHub token exchange failed.");
  }
  return body.access_token;
}

async function githubIdentity(accessToken: string): Promise<{ id: number; login: string }> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "durable-thinking/3.1.0",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (
    !response.ok ||
    !isRecord(body) ||
    typeof body.login !== "string" ||
    typeof body.id !== "number" ||
    !Number.isSafeInteger(body.id)
  ) {
    throw new Error("GitHub identity lookup failed.");
  }
  return { id: body.id, login: body.login };
}

export function isAllowedGitHubLogin(login: string, allowlist: string | undefined): boolean {
  const normalized = login.trim().toLowerCase();
  if (!normalized) return false;
  return (allowlist ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(normalized);
}

async function authorizeGet(request: Request, env: WorkerEnv): Promise<Response> {
  if (!githubConfigured(env)) {
    return errorPage(
      503,
      "GitHub sign-in unavailable",
      "GitHub OAuth is not configured for this deployment."
    );
  }
  try {
    const oauthRequest = await oauthHelpers(env).parseAuthRequest(request);
    const client = await oauthHelpers(env).lookupClient(oauthRequest.clientId);
    if (!client) {
      return errorPage(
        400,
        "Invalid authorization request",
        "The OAuth client is not registered."
      );
    }
    const stateToken = await storeFlow(env, CONSENT_STATE_PREFIX, oauthRequest);
    return consentPage(client, stateToken);
  } catch (error) {
    return authorizationErrorResponse(error);
  }
}

async function authorizePost(request: Request, env: WorkerEnv): Promise<Response> {
  if (!githubConfigured(env)) {
    return errorPage(
      503,
      "GitHub sign-in unavailable",
      "GitHub OAuth is not configured for this deployment."
    );
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorPage(400, "Invalid authorization request", "The consent form could not be read.");
  }
  const state = form.get("state");
  const oauthRequest = await takeFlow(
    request,
    env,
    CONSENT_STATE_PREFIX,
    typeof state === "string" ? state : null
  );
  if (!oauthRequest) {
    return withClearedStateCookie(
      errorPage(400, "Authorization expired", "Restart the connector sign-in and try again.")
    );
  }
  if (form.get("decision") !== "approve") {
    return withClearedStateCookie(
      oauthErrorRedirect(oauthRequest, "access_denied", "The user declined authorization.")
    );
  }
  const callbackState = await storeFlow(env, CALLBACK_STATE_PREFIX, oauthRequest);
  return githubAuthorizeResponse(request, env, callbackState);
}

async function callbackGet(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const oauthRequest = await takeFlow(
    request,
    env,
    CALLBACK_STATE_PREFIX,
    url.searchParams.get("state")
  );
  if (!oauthRequest) {
    return withClearedStateCookie(
      errorPage(400, "Authorization expired", "Restart the connector sign-in and try again.")
    );
  }

  if (url.searchParams.has("error")) {
    return withClearedStateCookie(
      oauthErrorRedirect(oauthRequest, "access_denied", "GitHub sign-in was not completed.")
    );
  }
  const code = url.searchParams.get("code");
  if (!code || !githubConfigured(env)) {
    return withClearedStateCookie(
      oauthErrorRedirect(oauthRequest, "server_error", "GitHub sign-in could not be completed.")
    );
  }

  try {
    const accessToken = await githubAccessToken(request, env, code);
    const identity = await githubIdentity(accessToken);
    if (!isAllowedGitHubLogin(identity.login, env.ALLOWED_GITHUB_LOGIN)) {
      return withClearedStateCookie(
        errorPage(403, "Access denied", "This GitHub account is not allowed to use this server.")
      );
    }

    const { redirectTo } = await oauthHelpers(env).completeAuthorization({
      request: oauthRequest,
      userId: `github-${identity.id}`,
      metadata: { githubLogin: identity.login },
      scope: oauthRequest.scope,
      props: { githubLogin: identity.login }
    });
    return withClearedStateCookie(Response.redirect(redirectTo, 302));
  } catch {
    return withClearedStateCookie(
      oauthErrorRedirect(oauthRequest, "server_error", "GitHub sign-in could not be completed.")
    );
  }
}

export async function githubOAuthResponse(
  request: Request,
  env: WorkerEnv
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname === "/authorize") {
    if (request.method === "GET") return authorizeGet(request, env);
    if (request.method === "POST") return authorizePost(request, env);
    return errorPage(405, "Method not allowed", "Use GET or POST for this endpoint.");
  }
  if (url.pathname === "/callback") {
    if (request.method === "GET") return callbackGet(request, env);
    return errorPage(405, "Method not allowed", "Use GET for this endpoint.");
  }
  return undefined;
}
