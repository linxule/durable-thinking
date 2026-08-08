# Contributing

Use Node.js 22 or newer. Install dependencies and run the complete verification pass before opening a pull request:

```bash
npm install
npm run verify
```

Preserve these design invariants:

1. MCP HTTP handling remains per-request and stateless. Do not use `Mcp-Session-Id` as application storage.
2. Persisted continuity remains explicit through `sequenceId`.
3. The ordinary `sequentialthinking` result keeps the current thought readable but does not repeat historical thoughts.
4. Full history remains retrievable through `get_thought_history` and deletable by the owner.
5. The MCP App remains one self-contained HTML document with no undeclared external network or asset dependencies.
6. The App represents a whole sequence in one card and treats the latest sequence state as authoritative.
7. The strict `/mcp` route remains modern-only; `/mcp-compat` remains the stateless legacy lane.
8. Every operation uses the fixed authenticated personal storage principal.
9. Thought text is never written to Worker logs.
10. Storage, schema, or pagination changes include tests for existing records, branches, revisions, retention, and deletion.

Do not commit generated secrets, `.dev.vars`, `node_modules`, build output, or private MCP client configuration.
