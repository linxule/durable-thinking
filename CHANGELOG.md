# Changelog

## 3.1.2 — 2026-08-08

Distribution metadata release.

- Add an official MCP Registry manifest for deploy-your-own remote Workers.
- Publish Registry metadata from GitHub Releases with secretless GitHub OIDC authentication.
- Pin and checksum the Registry publisher instead of executing an unversioned download.
- Keep npm publication disabled because Durable Thinking does not ship a local stdio executable.

## 3.1.1 — 2026-08-08

OAuth reliability release for hosted MCP clients.

- Allow the consent form's same-origin POST to follow its redirect to GitHub without weakening the rest of the page CSP.
- Replace eventually consistent KV-backed consent and callback state with short-lived HMAC-authenticated state.
- Retry transient authorization-grant reads during the hosted client's token exchange.
- Preserve path-specific protected-resource discovery for `/mcp` and `/mcp-compat`.
- Allow Claude and ChatGPT web origins by default while continuing to reject unrelated browser origins.
- Add credential-safe OAuth diagnostics and regression coverage for DCR, PKCE consent, CORS, and protected-resource metadata.
- Recommend `/mcp-compat` for current hosted web clients and document the end-to-end troubleshooting checks.
