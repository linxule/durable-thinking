import { PERSONAL_STORE_ID, type WorkerEnv } from "./config";
import type { ThoughtStore } from "./thought-store";

export function getThoughtStore(env: WorkerEnv): DurableObjectStub<ThoughtStore> {
  if (!env.THOUGHT_STORE) {
    throw new Error("The THOUGHT_STORE Durable Object binding is not configured.");
  }
  return env.THOUGHT_STORE.getByName(PERSONAL_STORE_ID);
}
