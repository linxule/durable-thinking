# Durable Thinking

[![CI](https://github.com/linxule/durable-thinking/actions/workflows/ci.yml/badge.svg)](https://github.com/linxule/durable-thinking/actions/workflows/ci.yml)

Persistent sequential thinking for MCP clients, on Cloudflare Workers.

The canonical Sequential Thinking server keeps thoughts in process memory and forgets them when the process exits. This one gives them somewhere durable to live — the same reasoning model (adjustable totals, continuation, revision, branching), just persisted instead of discarded. Every step is written to a SQLite-backed Cloudflare Durable Object, addressable later by an unguessable id, and — for clients that support MCP Apps — rendered as a card of its own.

It's a single-user deployment: one GitHub account allowed through the sign-in gate, one bearer token for header-capable clients, one private store, and a deploy-button template for standing up your own copy.

## What a thought looks like

A normal `sequentialthinking` call stays readable in any client:

```text
Thought 3/5

A Durable Object keeps the application history persistent while the MCP HTTP
transport remains stateless.

Sequence: seq_... · 3 thoughts stored
```

The structured result stays deliberately small — the thought itself isn't repeated in it:

```json
{
  "sequenceId": "seq_...",
  "thoughtNumber": 3,
  "totalThoughts": 5,
  "thoughtHistoryLength": 3
}
```

MCP Apps-capable hosts get the same thought delivered separately, to a UI resource: `ui://sequential-thinking/process.html`. Hosts render one card per tool call, so the App leans into that instead of fighting it — each card shows only its own thought, no polling, no state shared with other cards, and the chat transcript itself becomes the timeline. When the sequence finishes (`nextThoughtNeeded: false`), that last card loads the full stored history and renders the entire process at once: every thought in order, branches and revisions marked, earlier steps collapsed and expandable.

The App is one self-contained HTML document — no external scripts, fonts, or network calls. It reaches history only through the host's authenticated MCP connection. Clients without MCP Apps support just get the plain text result.

Thoughts aren't retransmitted on every write, either — only the current one. The model reloads earlier ones on purpose, with `get_thought_history`.

## Capability-scoped history

There's no tool to list sequences, and none is coming. The `sequenceId` handed back from the first call is the only way in — long enough to be unguessable, and the sole credential its history checks. Hold the id, read the sequence; don't have it, and it doesn't exist for you.

That's what lets one deployment serve many clients and sessions at once without any of them seeing each other's reasoning: authentication gets you in the door, the sequence id gets you into a room.

## Tools

### `sequentialthinking`

Persists one reasoning step. Omit `sequenceId` on the first call; carry the returned id through every continuation.

```text
thought
nextThoughtNeeded
thoughtNumber
totalThoughts
sequenceId?
isRevision?
revisesThought?
branchFromThought?
branchId?
branchFromBranchId?
needsMoreThoughts?
```

Branch by pairing `branchId` with `branchFromThought` (forking from the main path) or adding `branchFromBranchId` (forking from inside another branch), then keep passing that `branchId` on later steps. Revise with `isRevision: true` and `revisesThought`.

Thought numbers are scoped to the branch writing them, so two branches can each have their own thought 3 — a reference resolves against the branch being written, then its ancestors back to each fork point, nearest scope wins.

Two edge cases are accepted and flagged in the result rather than treated as errors: continuing a sequence after a thought said `nextThoughtNeeded: false` just reopens it, and reusing a thought number on the same branch resolves later references to its newest occurrence.

### `get_thought_history`

Returns full-text history, oldest-first and paginated — pass `nextCursor` back as `cursor` to continue (cursor values are opaque; don't compute them). Pass `branchId` to restrict the page to one branch; `sequence.branches` lists every branch with its parent and fork point.

### `delete_thought_sequence`

Permanently deletes a sequence and its stored text. Requires `confirm: true`.

## Architecture

```text
MCP client
    │
    │ POST /mcp or /mcp-compat
    │ OAuth access token or static bearer token
    ▼
Cloudflare Worker
    │
    │ static token → straight to the MCP handler
    │ anything else → workers-oauth-provider validation
    │ fresh MCP server for each request
    ▼
ThoughtStore Durable Object: "personal"
    │
    ▼
SQLite tables for sequences, thoughts, and branches
```

The MCP transport is stateless — no `Mcp-Session-Id` is used as a database key or continuity mechanism. All application state lives in the Durable Object instead, keyed by the `sequenceId` passed explicitly in tool arguments.

Only text submitted through the public `thought` argument is ever stored; the server has no access to a model's private or hidden reasoning.

## Deploy your own

### One click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/linxule/durable-thinking)

Deployment requires three secrets: `MCP_API_TOKEN` (the static bearer — generate at least 32 random bytes), plus `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from the OAuth app described under GitHub sign-in below.

```bash
openssl rand -hex 32
```

You'll also need your own OAuth KV namespace — `npx wrangler kv namespace create OAUTH_KV`, then put its id in `wrangler.jsonc` (namespace ids aren't secrets).

You'll get three endpoints:

```text
https://<worker>.<account>.workers.dev/mcp
https://<worker>.<account>.workers.dev/mcp-compat
https://<worker>.<account>.workers.dev/healthz
```

### GitHub sign-in

Browser-based clients authenticate by signing in to GitHub; access is granted only to allowlisted accounts.

1. Create an OAuth App under [GitHub Developer settings](https://github.com/settings/developers) — Homepage URL `https://<worker-host>`, callback URL `https://<worker-host>/callback`.
2. Store its credentials as Worker secrets: `npx wrangler secret put GITHUB_CLIENT_ID`, then `GITHUB_CLIENT_SECRET`.
3. Set the allowlist: `npx wrangler secret put ALLOWED_GITHUB_LOGIN` — one or more comma-separated GitHub logins, matched case-insensitively. Empty or missing fails closed: nobody can complete authorization. It's a secret rather than a `wrangler.jsonc` var so continuous deploys never overwrite it.

The sign-in flow reads only your GitHub identity, checks it against the allowlist, and discards the GitHub token. Authorization is keyed to the immutable account id, not the renameable login.

### Continuous deployment

GitHub Actions runs `npm run verify` on every pull request and every push to `main`; a verified push to `main` deploys the Worker with Wrangler. Deploys never overlap, and the deploy job skips gracefully when its credentials are absent — as in a fork.

Set these under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN` — Workers Scripts: Edit permission;
- `CLOUDFLARE_ACCOUNT_ID` — the account that owns the Worker.

These authorize deployment and are separate from the runtime secrets above.

### By hand

Requirements: Node.js 22+, a Cloudflare account with Workers and Durable Objects enabled, Wrangler authenticated.

```bash
npm install
npm run verify
npm run secrets            # generates a local token
```

Copy the result into an uncommitted `.dev.vars` (see `.dev.vars.example` for the GitHub fields):

```dotenv
MCP_API_TOKEN=<generated token>
```

```bash
npm run dev
```

When ready to ship:

```bash
npx wrangler secret put MCP_API_TOKEN
npm run deploy
```

### Configuration

`wrangler.jsonc` declares the Durable Object and KV bindings. Optional Worker variables, set via Cloudflare or a local `.dev.vars`:

| Variable | Default | Purpose |
|---|---:|---|
| `THOUGHT_RETENTION_DAYS` | `0` | `0` retains sequences until explicit deletion; a positive value enables sliding expiration. |
| `ALLOWED_HOSTNAMES` | automatic | Optional comma-separated host allowlist, for custom domains. |
| `ALLOWED_ORIGIN_HOSTNAMES` | automatic | Optional comma-separated browser-Origin hostname allowlist. |

There's deliberately no public mode, tenant selector, configurable storage id, thought-logging switch, or automatic recent-history return — one user, one hard-coded Durable Object name: `personal`. Rotating `MCP_API_TOKEN` or the OAuth credentials doesn't orphan history; storage identity is independent of both.

## Connect your clients

Two doors, one server.

**Browser sign-in** — for clients that can't send custom headers (claude.ai web, Claude Desktop connectors). Add a custom connector pointing at:

```text
https://<worker-host>/mcp
```

The client discovers the OAuth endpoints, registers itself, and opens a consent page; continue to GitHub, and if your login is on the allowlist, you're in.

**Bearer header** — for CLIs and anything header-capable:

```http
Authorization: Bearer <MCP_API_TOKEN>
```

An exact token match routes straight to the MCP handler; the OAuth machinery never sees it.

Either way, use `/mcp` for MCP 2026-07-28 clients and `/mcp-compat` for 2025-era Streamable HTTP clients.

## Retention and privacy

Thought text can contain private prompt context, copied credentials, personal information, or uncertain conclusions. The server treats it accordingly:

- every MCP request authenticates — an issued OAuth token or the bearer secret;
- thought text is never logged;
- one private Durable Object, owned by you alone;
- the App's CSP blocks all outbound network access;
- sequences can be deleted explicitly, and are retained indefinitely by default.

CORS and MCP App visibility metadata are not authentication controls — keep the bearer token secret.

## Development

```bash
npm run check:app       # validates the self-contained MCP App and protocol surface
npm run check:contract  # guards the compact tool and visibility contract
npm run typecheck       # Worker and test TypeScript projects
npm run test            # Durable Object, auth, routes, and App invariants
npm run build           # Wrangler dry run
npm run verify          # all checks above
```

`src/ui/thought-process.html` is the App's source of truth; Wrangler imports it as a text module via the rule in `wrangler.jsonc`.

```text
src/index.ts                 Worker routes, authentication boundary, MCP handler
src/server.ts                tools, compact return shapes, MCP App resource
src/thought-store.ts         SQLite Durable Object implementation
src/oauth.ts                 GitHub sign-in and consent flow around the OAuth provider
src/ui/thought-process.html  per-thought MCP App card with final process view
src/auth.ts                  fixed personal bearer authentication
src/model.ts                 storage commands and records
test/                        Worker, storage, auth, and App tests
```

## License

MIT. See `LICENSE` and `NOTICE`.
