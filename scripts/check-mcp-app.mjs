import { readFile } from "node:fs/promises";
import { Script } from "node:vm";

const path = new URL("../src/ui/thought-process.html", import.meta.url);
const html = await readFile(path, "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(/<!doctype html>/iu.test(html), "MCP App must be a complete HTML document.");
assert(!/<script\b[^>]*\bsrc\s*=/iu.test(html), "MCP App must not load external scripts.");
assert(!/<link\b[^>]*\bhref\s*=/iu.test(html), "MCP App must remain self-contained.");
assert(!/<img\b/iu.test(html), "MCP App must not load external images.");
assert(!/<iframe\b/iu.test(html), "MCP App must not nest frames.");
assert((html.match(/id=["']card["']/giu) ?? []).length === 1, "MCP App must render exactly one root card.");

const required = [
  "ui/initialize",
  "ui/notifications/initialized",
  "ui/notifications/tool-input",
  "ui/notifications/tool-result",
  "ui/notifications/size-changed",
  "ui/resource-teardown",
  "tools/call",
  "get_thought_history",
  "loadJourney",
  "Sequential Thinking"
];
for (const marker of required) {
  assert(html.includes(marker), `MCP App is missing required marker: ${marker}`);
}

// One card per tool call: the cross-card election machinery (polling,
// BroadcastChannel, localStorage, stale snapshots) must stay gone.
for (const forbidden of [
  "BroadcastChannel",
  "localStorage",
  "setInterval",
  "get_thought_sequence_state",
  "request-teardown",
  "Load earlier thoughts",
  "Stored privately"
]) {
  assert(!html.includes(forbidden), `MCP App must not reintroduce: ${forbidden}`);
}

assert(
  html.includes("[hidden] { display: none !important; }"),
  "The [hidden] override must stay: class display rules silently defeat the hidden attribute without it."
);

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)];
assert(scripts.length === 1, `Expected one inline script, found ${scripts.length}.`);
new Script(scripts[0]?.[1] ?? "", { filename: "thought-process.inline.js" });

console.log(`MCP App checked: ${html.length.toLocaleString()} bytes, one self-contained script.`);
