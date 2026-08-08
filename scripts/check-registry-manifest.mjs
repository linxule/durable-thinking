import { readFile } from "node:fs/promises";

const [manifest, packageJson] = await Promise.all([
  readFile(new URL("../server.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse)
]);

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

expect(
  manifest.$schema ===
    "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "server.json must use the current pinned Registry schema"
);
expect(
  manifest.name === "io.github.linxule/durable-thinking",
  "server.json must use the repository-owned MCP namespace"
);
expect(
  manifest.version === packageJson.version,
  "server.json and package.json versions must match"
);
expect(
  typeof manifest.description === "string" &&
    manifest.description.length > 0 &&
    manifest.description.length <= 100,
  "Registry descriptions must contain 1-100 characters"
);
expect(
  manifest.repository?.url === "https://github.com/linxule/durable-thinking" &&
    manifest.repository?.source === "github" &&
    manifest.repository?.id === "1327670743",
  "server.json repository identity must remain pinned to this GitHub repository"
);
expect(
  !Object.hasOwn(manifest, "packages"),
  "Durable Thinking is remote-only; do not advertise a nonexistent installable package"
);
expect(
  Array.isArray(manifest.remotes) &&
    manifest.remotes.length === 1 &&
    manifest.remotes[0]?.type === "streamable-http" &&
    manifest.remotes[0]?.url === "https://{worker_host}/mcp-compat" &&
    manifest.remotes[0]?.variables?.worker_host?.isRequired === true,
  "server.json must advertise the deploy-your-own /mcp-compat Worker template"
);

if (failures.length > 0) {
  for (const failure of failures) console.error(`Registry manifest check failed: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Registry manifest checked: ${manifest.name}@${manifest.version}, remote Worker template only.`
  );
}
