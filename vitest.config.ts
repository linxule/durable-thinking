import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          MCP_API_TOKEN: "test-token-0123456789abcdef0123456789abcdef",
          GITHUB_CLIENT_ID: "test-github-client-id",
          GITHUB_CLIENT_SECRET: "test-github-client-secret",
          ALLOWED_GITHUB_LOGIN: "allowed-user",
          ALLOWED_HOSTNAMES: "example.com",
          ALLOWED_ORIGIN_HOSTNAMES: "example.com"
        }
      }
    })
  ],
  test: {
    coverage: {
      reporter: ["text", "json", "html"]
    }
  }
});
