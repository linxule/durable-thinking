# Durable Thinking Agent Guide

This repository is an independent Git repository nested inside the broader MCP
workspace. Run Git commands from this directory and do not stage it through the
parent workspace.

## Project Shape

- Durable Thinking is a private, remote-only MCP server on Cloudflare Workers.
- Persistence lives in a SQLite-backed Durable Object and is scoped by explicit,
  unguessable `sequenceId` values.
- `/mcp` is the strict current-protocol endpoint. `/mcp-compat` is the hosted-web
  client compatibility endpoint and is the default documented connection URL.
- Authentication supports the private bearer token and Worker-issued OAuth
  tokens backed by GitHub sign-in and an explicit GitHub-user allowlist.
- The MCP App is the self-contained document at `src/ui/thought-process.html`.

## Toolchain and Verification

This project intentionally uses npm, overriding the parent workspace's usual Bun
default. Use Node.js 22 or newer.

```bash
npm ci
npm run verify
```

`npm run verify` is the required completion check. It validates the MCP App,
server contract, Registry manifest and version alignment, TypeScript projects,
tests, and a Wrangler dry build. Use narrower scripts while iterating, but run
the complete command before committing or releasing.

Use `npm run dev` for local development and `npm run deploy` for an authorized
manual Cloudflare deployment.

## Design and Security Invariants

Read `CONTRIBUTING.md` before changing MCP behavior, storage, OAuth, routing, or
the App. Its numbered invariants are canonical; do not duplicate or weaken them
here.

- Keep MCP HTTP handling stateless. Application continuity belongs to
  `sequenceId`, never transport session state.
- Preserve the fixed personal storage principal and ownership checks.
- Treat `/mcp` and `/mcp-compat` as distinct protected resources. OAuth metadata
  must advertise the exact client-entered path.
- Never log thought text, credentials, authorization codes, state payloads,
  access tokens, refresh tokens, or bearer secrets.
- Never read, display, commit, or overwrite `.dev.vars`. Use
  `.dev.vars.example` when documenting configuration.
- Keep the MCP App self-contained with no undeclared external assets or network
  dependencies.

## Change Map

- `src/index.ts`: Worker routing, security headers, discovery, and top-level
  responses.
- `src/oauth.ts`: OAuth authorization server, consent, callbacks, and token flow.
- `src/server.ts`: MCP tools, protocol handling, and App resources.
- `src/thought-store.ts`: Durable Object persistence and ownership enforcement.
- `src/auth.ts` and `src/config.ts`: bearer authentication and validated runtime
  configuration.
- `test/worker.test.ts`: route, OAuth, CORS, and protocol regressions.
- `test/thought-store.test.ts`: persistence, revisions, retention, and deletion.
- `scripts/check-*.mjs`: release-time static contracts; update them when an
  intentional contract change would otherwise make them fail.

## Release and Distribution

- Keep the release version synchronized across `package.json`,
  `package-lock.json`, `server.json`, runtime metadata, tests, and `CHANGELOG.md`.
  The verification scripts enforce the machine-checkable subset.
- Pushes to `main` run CI. Cloudflare deployment occurs only when the repository
  credentials are configured; otherwise the deploy job deliberately skips.
- Publishing a GitHub Release triggers `.github/workflows/publish-mcp.yml`, which
  publishes the remote template to the official MCP Registry using GitHub OIDC.
- Do not run `npm publish`: this is a private Cloudflare application with no
  stdio executable or installable npm package.
- Do not publish the private live Worker URL to Smithery. Reconsider only if the
  access model becomes suitable for unrelated users or Smithery supports the
  deploy-your-own URL template.

Before staging, inspect `git status --short` and preserve unrelated work. Never
commit secrets, `.dev.vars`, `node_modules`, `dist`, `.wrangler`, or private MCP
client configuration.
