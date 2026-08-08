import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const outputMatch = source.match(
  /const sequentialThinkingOutputSchema = z\.object\(\{([\s\S]*?)\n\}\);/u
);
assert(outputMatch, "Could not locate the sequentialthinking output schema.");
const outputBody = outputMatch[1];
for (const field of ["sequenceId", "thoughtNumber", "totalThoughts", "thoughtHistoryLength"]) {
  assert(new RegExp(`\\b${field}\\s*:`, "u").test(outputBody), `Missing compact output field: ${field}`);
}
for (const forbidden of [
  "thought:",
  "recentThoughts",
  "sequence:",
  "branches:",
  "nextThoughtNeeded:",
  "deduplicated",
  "historyTruncated"
]) {
  assert(!outputBody.includes(forbidden), `Unexpected ordinary output field: ${forbidden}`);
}

assert(source.includes("value.thought.thought"), "The readable text result must include the current thought.");
assert(source.includes('resourceUri: THOUGHT_APP_URI'), "The thought tool must reference the MCP App resource.");
assert(source.includes('extensions: { "io.modelcontextprotocol/ui": {} }'), "The server must advertise MCP Apps support.");
assert(source.includes('mimeType: MCP_APP_MIME_TYPE'), "The MCP App resource MIME type must be declared.");
assert(!source.includes('"ui/resourceUri"'), "Do not restore the deprecated flat UI metadata alias.");

const inputMatch = source.match(
  /const sequentialThinkingInputSchema = z\.object\(\{([\s\S]*?)\n\}\);/u
);
assert(inputMatch, "Could not locate the sequentialthinking input schema.");
for (const forbidden of ["sequenceTitle", "clientRequestId", "historyLimit", "stateHandle"]) {
  assert(!inputMatch[1].includes(forbidden), `Unexpected personal-edition input field: ${forbidden}`);
}

assert(
  !source.includes("z.preprocess("),
  "Do not use z.preprocess in input schemas: it erases required status in JSON-schema conversion (advertises required fields as optional)."
);

const registeredTools = [...source.matchAll(/server\.registerTool\(\s*\n\s*"([^"]+)"/gu)].map(
  (match) => match[1]
);
assert(
  JSON.stringify(registeredTools) ===
    JSON.stringify(["sequentialthinking", "get_thought_history", "delete_thought_sequence"]),
  `Unexpected registered tool surface: ${registeredTools.join(", ")}`
);

// The unguessable sequenceId is the capability that scopes a sequence to the
// conversation that created it. A global listing tool would expose every
// session's history to every connected client — do not restore it.
assert(
  !source.includes("list_thought_sequences\","),
  "Do not register a global sequence listing: sequenceId is the access capability."
);
assert(
  !source.includes('"get_thought_sequence_state"'),
  "The App-only freshness tool was retired with the per-card polling design."
);

console.log("Server contract checked: current thought is readable, structured output is compact, three tools are registered, and history stays scoped to the sequenceId capability.");
