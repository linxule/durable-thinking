# Security policy

## Personal deployment model

This repository is designed for one person running one Cloudflare deployment.
Every MCP request, except an allowed browser preflight, requires either an
access token issued by the Worker's OAuth provider after GitHub sign-in or the
configured `MCP_API_TOKEN`. OAuth authorization fails closed unless the GitHub
login is present in `ALLOWED_GITHUB_LOGIN`. Authentication cannot be disabled
through the default code or configuration.

Consent and callback state is short-lived and HMAC-authenticated rather than
stored as cross-request browser state. The consent page permits form navigation
only to the Worker itself and GitHub. OAuth diagnostics record fixed stage and
reason fields but never authorization codes, state payloads, access tokens,
client secrets, or request authorization headers.

All histories live in one Durable Object named `personal`. Rotating the bearer
token or OAuth credentials does not select a different store.

## Sensitive data

Every string supplied through the `thought` argument is persisted in SQLite.
It may contain private user context, copied secrets, speculative conclusions, or
other sensitive material. The Worker does not log complete thought text. Delete
unneeded sequences with `delete_thought_sequence`.

The embedded MCP App is self-contained. It requests no browser permissions and
declares no external network, resource, or frame domains.

## Reporting a vulnerability

Please open a private GitHub security advisory for the repository rather than a
public issue. Include the affected version, reproduction steps, impact, and any
suggested mitigation.
