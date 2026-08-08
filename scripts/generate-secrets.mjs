import { randomBytes } from "node:crypto";

console.log(`MCP_API_TOKEN=${randomBytes(32).toString("hex")}`);
