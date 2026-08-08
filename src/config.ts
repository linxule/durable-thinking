import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { ThoughtStore } from "./thought-store";

export interface WorkerSettings {
  MCP_API_TOKEN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  ALLOWED_GITHUB_LOGIN?: string;
  THOUGHT_RETENTION_DAYS?: string;
  ALLOWED_HOSTNAMES?: string;
  ALLOWED_ORIGIN_HOSTNAMES?: string;
}

export interface WorkerEnv extends WorkerSettings {
  THOUGHT_STORE: DurableObjectNamespace<ThoughtStore>;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
}

export const MIN_SECRET_LENGTH = 32;
export const PERSONAL_STORE_ID = "personal";
const MAX_RETENTION_DAYS = 3_650;

export function hasStrongSecret(value: string | undefined): value is string {
  return (value?.trim().length ?? 0) >= MIN_SECRET_LENGTH;
}

export function thoughtRetentionDays(env: WorkerSettings): number {
  const raw = env.THOUGHT_RETENTION_DAYS?.trim();
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
  return Math.min(parsed, MAX_RETENTION_DAYS);
}

export function csv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}
