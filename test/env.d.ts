import type { WorkerEnv } from "../src/config";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends WorkerEnv {}
}
