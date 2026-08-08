import { describe, expect, it } from "vitest";
import thoughtProcessHtml from "../src/ui/thought-process.html";

const appUri = "ui://sequential-thinking/process.html";
const appMimeType = "text/html;profile=mcp-app";

describe("Sequential Thinking MCP App", () => {
  it("is one self-contained current MCP Apps document", () => {
    expect(appUri).toBe("ui://sequential-thinking/process.html");
    expect(appMimeType).toBe("text/html;profile=mcp-app");
    expect(thoughtProcessHtml).toContain('request("ui/initialize"');
    expect(thoughtProcessHtml).toContain('const APP_PROTOCOL_VERSION = "2026-01-26"');
    expect(thoughtProcessHtml).toContain('const HISTORY_TOOL = "get_thought_history"');
    expect(thoughtProcessHtml).toContain('id="card"');
    expect(thoughtProcessHtml.match(/id="card"/gu)).toHaveLength(1);
  });

  it("does not load external scripts, styles, images, or frames", () => {
    expect(thoughtProcessHtml).not.toMatch(/<script[^>]+src=/iu);
    expect(thoughtProcessHtml).not.toMatch(/<link[^>]+href=/iu);
    expect(thoughtProcessHtml).not.toMatch(/<img\b/iu);
    expect(thoughtProcessHtml).not.toMatch(/<iframe\b/iu);
  });

  it("renders one thought per card and loads the journey only on the final card", () => {
    expect(thoughtProcessHtml).toContain("loadJourney");
    expect(thoughtProcessHtml).toContain("isFinalThought");
    expect(thoughtProcessHtml).toContain("Complete process");
    // The hidden attribute must beat class display rules, or retired
    // controls leak back into view (the old "Load earlier thoughts" bug).
    expect(thoughtProcessHtml).toContain("[hidden] { display: none !important; }");
  });

  it("keeps the cross-card election machinery removed", () => {
    expect(thoughtProcessHtml).not.toContain("BroadcastChannel");
    expect(thoughtProcessHtml).not.toContain("localStorage");
    expect(thoughtProcessHtml).not.toContain("setInterval");
    expect(thoughtProcessHtml).not.toContain("get_thought_sequence_state");
    expect(thoughtProcessHtml).not.toContain("request-teardown");
    expect(thoughtProcessHtml).not.toContain("Load earlier thoughts");
    expect(thoughtProcessHtml).not.toContain("Stored privately");
  });
});
