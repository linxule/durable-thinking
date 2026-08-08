import {
  AuthorizationError,
  type AuthRequest,
  type ClientInfo
} from "@cloudflare/workers-oauth-provider";
import type { WorkerEnv } from "./config";

const FLOW_TTL_SECONDS = 10 * 60;

// Flow state is stateless and HMAC-signed, round-tripped through the consent
// form and GitHub's `state` parameter. Workers KV is eventually consistent
// across edge locations, so a KV-stored flow written on one request was
// sometimes invisible to the next request seconds later ("state_not_found"
// in production). Nothing here needs propagation: possession of a validly
// signed, unexpired token IS the flow state. Replay is bounded by the TTL,
// by GitHub authorization codes being single-use, and by PKCE at the token
// exchange.
type FlowPurpose = "consent" | "callback";

type FlowPayload = {
  p: FlowPurpose;
  iat: number;
  r: AuthRequest;
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
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'"
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
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize Durable Thinking</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#f6f7f9;color:#17202a;margin:0}.card{max-width:34rem;margin:8vh auto;background:white;border:1px solid #d8dde3;border-radius:14px;padding:2rem;box-shadow:0 8px 28px #17202a14}h1{font-size:1.5rem;margin-top:0}.actions{display:flex;gap:.75rem;margin-top:1.5rem}button{font:inherit;border-radius:8px;padding:.65rem 1rem;border:1px solid #aeb6bf;background:white;cursor:pointer}.primary{background:#17202a;color:white;border-color:#17202a}</style><main class="card"><h1>Connect Durable Thinking</h1><p><strong>${htmlEscape(clientName)}</strong> wants to connect to this private MCP server.</p><p>Continue to GitHub to verify that your account is on the server allowlist. Durable Thinking will read only your GitHub account identity and will not retain the GitHub access token.</p><form method="post" action="/authorize"><input type="hidden" name="state" value="${htmlEscape(stateToken)}"><div class="actions"><button class="primary" type="submit" name="decision" value="approve">Continue with GitHub</button><button type="submit" name="decision" value="deny">Cancel</button></div></form></main></html>`
  );
}

function oauthHelpers(env: WorkerEnv) {
  if (!env.OAUTH_PROVIDER) throw new Error("OAuth provider helpers are unavailable.");
  return env.OAUTH_PROVIDER;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

let cachedFlowKey: { material: string; key: CryptoKey } | undefined;

async function flowSigningKey(env: WorkerEnv): Promise<CryptoKey> {
  const material = env.MCP_API_TOKEN;
  if (!material) throw new Error("Flow signing requires MCP_API_TOKEN.");
  if (cachedFlowKey?.material === material) return cachedFlowKey.key;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`durable-thinking-oauth-flow:${material}`)
  );
  const key = await crypto.subtle.importKey(
    "raw",
    digest,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  cachedFlowKey = { material, key };
  return key;
}

async function signFlowState(
  env: WorkerEnv,
  purpose: FlowPurpose,
  oauthRequest: AuthRequest
): Promise<string> {
  const payload: FlowPayload = {
    p: purpose,
    iat: Math.floor(Date.now() / 1000),
    r: oauthRequest
  };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const signature = await crypto.subtle.sign("HMAC", await flowSigningKey(env), body);
  return `${base64UrlEncode(body)}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifyFlowState(
  env: WorkerEnv,
  purpose: FlowPurpose,
  token: string | null
): Promise<AuthRequest | undefined> {
  if (!token || token.length > 8192) {
    logFlowFailure(purpose, "missing_state");
    return undefined;
  }
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    logFlowFailure(purpose, "malformed_state");
    return undefined;
  }
  const body = base64UrlDecode(token.slice(0, dot));
  const signature = base64UrlDecode(token.slice(dot + 1));
  if (!body || !signature) {
    logFlowFailure(purpose, "malformed_state");
    return undefined;
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    await flowSigningKey(env),
    signature as unknown as BufferSource,
    body as unknown as BufferSource
  );
  if (!valid) {
    logFlowFailure(purpose, "bad_signature");
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    logFlowFailure(purpose, "malformed_payload");
    return undefined;
  }
  if (!isRecord(payload) || payload.p !== purpose) {
    logFlowFailure(purpose, "wrong_purpose");
    return undefined;
  }
  if (typeof payload.iat !== "number" || Math.floor(Date.now() / 1000) - payload.iat > FLOW_TTL_SECONDS) {
    logFlowFailure(purpose, "expired");
    return undefined;
  }
  if (!isAuthRequest(payload.r)) {
    logFlowFailure(purpose, "invalid_auth_request");
    return undefined;
  }
  return payload.r;
}

function logFlowFailure(stage: string, reason: string): void {
  // Reason codes only; never state tokens or cookie values.
  console.error(JSON.stringify({ event: "oauth_flow_state_invalid", stage, reason }));
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
      "User-Agent": "durable-thinking/3.1.2"
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
    // GitHub reports failures as an `error` code in the body (often with HTTP
    // 200) — e.g. incorrect_client_credentials vs bad_verification_code. Log
    // only that code and the status; never the body (success bodies carry the
    // access token).
    console.error(
      JSON.stringify({
        event: "github_token_exchange_failed",
        status: response.status,
        githubError:
          isRecord(body) && typeof body.error === "string" ? body.error : "unknown"
      })
    );
    throw new Error("GitHub token exchange failed.");
  }
  return body.access_token;
}

async function githubIdentity(accessToken: string): Promise<{ id: number; login: string }> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "durable-thinking/3.1.2",
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
    console.error(
      JSON.stringify({ event: "github_identity_failed", status: response.status })
    );
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
    let client = await oauthHelpers(env).lookupClient(oauthRequest.clientId);
    // The client record is written by POST /register (a hosted MCP backend)
    // and read here on the user's browser request — usually different colos,
    // and the record lives in eventually-consistent KV. Give replication a
    // moment before rejecting a freshly registered client.
    for (const delay of [300, 700]) {
      if (client) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      client = await oauthHelpers(env).lookupClient(oauthRequest.clientId);
      console.error(
        JSON.stringify({ event: "oauth_client_lookup_retry", delay, found: Boolean(client) })
      );
    }
    if (!client) {
      console.error(
        JSON.stringify({ event: "oauth_authorize_rejected", reason: "client_not_registered" })
      );
      return errorPage(
        400,
        "Invalid authorization request",
        "The OAuth client is not registered."
      );
    }
    const stateToken = await signFlowState(env, "consent", oauthRequest);
    return consentPage(client, stateToken);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "oauth_authorize_failed",
        reason: error instanceof AuthorizationError ? error.code : "internal_error"
      })
    );
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
  // CSRF guard for the consent form: a cross-site forgery cannot present
  // Sec-Fetch-Site: same-origin. Agents that omit the header (non-browser
  // tooling) are accepted — every real consent click comes from a browser,
  // and all current browsers send it.
  const secFetchSite = request.headers.get("Sec-Fetch-Site");
  if (secFetchSite && secFetchSite !== "same-origin") {
    logFlowFailure("consent", "cross_site_post");
    return errorPage(403, "Request blocked", "The consent form must be submitted from this site.");
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorPage(400, "Invalid authorization request", "The consent form could not be read.");
  }
  const state = form.get("state");
  const oauthRequest = await verifyFlowState(
    env,
    "consent",
    typeof state === "string" ? state : null
  );
  if (!oauthRequest) {
    return errorPage(400, "Authorization expired", "Restart the connector sign-in and try again.");
  }
  if (form.get("decision") !== "approve") {
    return oauthErrorRedirect(oauthRequest, "access_denied", "The user declined authorization.");
  }
  const callbackState = await signFlowState(env, "callback", oauthRequest);
  return githubAuthorizeResponse(request, env, callbackState);
}

async function callbackGet(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  console.error(
    JSON.stringify({
      event: "oauth_callback_received",
      hasCode: url.searchParams.has("code"),
      hasError: url.searchParams.has("error"),
      hasState: url.searchParams.has("state")
    })
  );
  const oauthRequest = await verifyFlowState(env, "callback", url.searchParams.get("state"));
  if (!oauthRequest) {
    return errorPage(400, "Authorization expired", "Restart the connector sign-in and try again.");
  }

  if (url.searchParams.has("error")) {
    return oauthErrorRedirect(oauthRequest, "access_denied", "GitHub sign-in was not completed.");
  }
  const code = url.searchParams.get("code");
  if (!code || !githubConfigured(env)) {
    return oauthErrorRedirect(oauthRequest, "server_error", "GitHub sign-in could not be completed.");
  }

  let stage = "token_exchange";
  try {
    const accessToken = await githubAccessToken(request, env, code);
    stage = "identity";
    const identity = await githubIdentity(accessToken);
    if (!isAllowedGitHubLogin(identity.login, env.ALLOWED_GITHUB_LOGIN)) {
      console.error(JSON.stringify({ event: "oauth_callback_denied", reason: "login_not_allowed" }));
      return errorPage(403, "Access denied", "This GitHub account is not allowed to use this server.");
    }

    stage = "complete_authorization";
    const { redirectTo } = await oauthHelpers(env).completeAuthorization({
      request: oauthRequest,
      userId: `github-${identity.id}`,
      metadata: { githubLogin: identity.login },
      scope: oauthRequest.scope,
      props: { githubLogin: identity.login }
    });
    return Response.redirect(redirectTo, 302);
  } catch {
    // Stage + fixed reason only — never tokens, codes, or response bodies.
    console.error(
      JSON.stringify({
        event: "oauth_callback_failed",
        stage,
        reason: "stage_failed"
      })
    );
    return oauthErrorRedirect(oauthRequest, "server_error", "GitHub sign-in could not be completed.");
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
