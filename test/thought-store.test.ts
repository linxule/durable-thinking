import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { WorkerEnv } from "../src/config";
import {
  DEFAULT_HISTORY_CHARACTERS,
  MAIN_BRANCH_ID,
  type AppendThoughtCommand,
  type StoreResult
} from "../src/model";

const workerEnv = env as unknown as WorkerEnv;

function store() {
  return workerEnv.THOUGHT_STORE.getByName(`test-${crypto.randomUUID()}`);
}

function appendCommand(
  overrides: Partial<AppendThoughtCommand> = {}
): AppendThoughtCommand {
  return {
    sequenceId: null,
    sequenceTitle: null,
    thought: "Identify the constraints.",
    nextThoughtNeeded: true,
    thoughtNumber: 1,
    totalThoughts: 3,
    isRevision: false,
    revisesThought: null,
    branchFromThought: null,
    branchFromBranchId: null,
    branchId: MAIN_BRANCH_ID,
    needsMoreThoughts: false,
    clientRequestId: null,
    returnHistoryLimit: 6,
    now: Date.now(),
    ...overrides
  };
}

function unwrap<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

describe("ThoughtStore", () => {
  it("persists full thought text across calls and Durable Object eviction", async () => {
    const stub = store();
    const first = unwrap(
      await stub.appendThought(
        appendCommand({
          sequenceTitle: "Architecture decision",
          thought: "Compare stateless MCP transport with durable application state."
        })
      )
    );

    const second = unwrap(
      await stub.appendThought(
        appendCommand({
          sequenceId: first.sequenceId,
          thought: "Use a named SQLite-backed Durable Object for the full text history.",
          thoughtNumber: 2,
          totalThoughts: 3,
          now: Date.now() + 1
        })
      )
    );

    expect(second.thought.thought).toContain("SQLite-backed Durable Object");
    expect(second.recentThoughts.map((entry) => entry.thought)).toEqual([
      "Compare stateless MCP transport with durable application state.",
      "Use a named SQLite-backed Durable Object for the full text history."
    ]);

    await evictDurableObject(stub);

    const history = unwrap(
      await stub.getHistory({
        sequenceId: first.sequenceId,
        limit: 50,
        cursor: null,
        order: "asc",
        branchId: null,
        maxCharacters: DEFAULT_HISTORY_CHARACTERS,
        now: Date.now() + 2
      })
    );

    expect(history.thoughts).toHaveLength(2);
    expect(history.thoughts[0]?.thought).toBe(
      "Compare stateless MCP transport with durable application state."
    );
    expect(history.thoughts[1]?.thought).toBe(
      "Use a named SQLite-backed Durable Object for the full text history."
    );
  });

  it("deduplicates first-call and continuation retries", async () => {
    const stub = store();
    const firstRequestId = `request-${crypto.randomUUID()}`;
    const firstCommand = appendCommand({
      thought: "This exact first request should be stored once.",
      clientRequestId: firstRequestId
    });

    const first = unwrap(await stub.appendThought(firstCommand));
    const firstRetry = unwrap(
      await stub.appendThought({ ...firstCommand, now: firstCommand.now + 1 })
    );

    expect(firstRetry.deduplicated).toBe(true);
    expect(firstRetry.sequenceId).toBe(first.sequenceId);
    expect(firstRetry.thought.id).toBe(first.thought.id);
    expect(firstRetry.thoughtHistoryLength).toBe(1);

    const continuationCommand = appendCommand({
      sequenceId: first.sequenceId,
      thought: "This exact continuation should also be stored once.",
      thoughtNumber: 2,
      clientRequestId: `request-${crypto.randomUUID()}`,
      now: firstCommand.now + 2
    });
    const continuation = unwrap(await stub.appendThought(continuationCommand));
    const continuationRetry = unwrap(
      await stub.appendThought({ ...continuationCommand, now: continuationCommand.now + 1 })
    );

    expect(continuationRetry.deduplicated).toBe(true);
    expect(continuationRetry.thought.id).toBe(continuation.thought.id);
    expect(continuationRetry.thoughtHistoryLength).toBe(2);

    const conflict = await stub.appendThought({
      ...firstCommand,
      thought: "Different text with the same idempotency key.",
      now: firstCommand.now + 4
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: "idempotency_conflict" }
    });
  });

  it("returns compact sequence state for MCP App freshness checks", async () => {
    const stub = store();
    const first = unwrap(
      await stub.appendThought(
        appendCommand({
          thought: "Begin a persisted process.",
          totalThoughts: 4
        })
      )
    );

    const initialState = unwrap(
      await stub.getSequenceState({ sequenceId: first.sequenceId, now: Date.now() + 1 })
    );
    expect(initialState).toEqual({
      sequenceId: first.sequenceId,
      completed: false,
      thoughtHistoryLength: 1,
      lastThoughtNumber: 1,
      totalThoughts: 4
    });

    unwrap(
      await stub.appendThought(
        appendCommand({
          sequenceId: first.sequenceId,
          thought: "Finish the persisted process.",
          thoughtNumber: 2,
          totalThoughts: 4,
          nextThoughtNeeded: false,
          now: Date.now() + 2
        })
      )
    );

    const completedState = unwrap(
      await stub.getSequenceState({ sequenceId: first.sequenceId, now: Date.now() + 3 })
    );
    expect(completedState).toEqual({
      sequenceId: first.sequenceId,
      completed: true,
      thoughtHistoryLength: 2,
      lastThoughtNumber: 2,
      totalThoughts: 4
    });
  });

  it("paginates full-text history without skipping entries", async () => {
    const stub = store();
    const first = unwrap(
      await stub.appendThought(appendCommand({ thought: "First persisted thought." }))
    );

    for (const [index, thought] of [
      "Second persisted thought.",
      "Third persisted thought.",
      "Fourth persisted thought."
    ].entries()) {
      unwrap(
        await stub.appendThought(
          appendCommand({
            sequenceId: first.sequenceId,
            thought,
            thoughtNumber: index + 2,
            totalThoughts: 4,
            now: Date.now() + index + 1
          })
        )
      );
    }

    const pageOne = unwrap(
      await stub.getHistory({
        sequenceId: first.sequenceId,
        limit: 2,
        cursor: null,
        order: "asc",
        branchId: null,
        maxCharacters: DEFAULT_HISTORY_CHARACTERS,
        now: Date.now() + 10
      })
    );
    expect(pageOne.thoughts.map((entry) => entry.thought)).toEqual([
      "First persisted thought.",
      "Second persisted thought."
    ]);
    expect(pageOne.hasMore).toBe(true);
    expect(pageOne.nextCursor).toBe(pageOne.thoughts.at(-1)?.ordinal);

    const pageTwo = unwrap(
      await stub.getHistory({
        sequenceId: first.sequenceId,
        limit: 2,
        cursor: pageOne.nextCursor,
        order: "asc",
        branchId: null,
        maxCharacters: DEFAULT_HISTORY_CHARACTERS,
        now: Date.now() + 11
      })
    );
    expect(pageTwo.thoughts.map((entry) => entry.thought)).toEqual([
      "Third persisted thought.",
      "Fourth persisted thought."
    ]);
    expect(pageTwo.hasMore).toBe(false);
    expect(pageTwo.nextCursor).toBeNull();
  });

  it("guarantees cursor progress when one thought exceeds the character budget", async () => {
    const stub = store();
    const first = unwrap(
      await stub.appendThought(
        appendCommand({
          thought: "This thought is deliberately longer than the one-character budget."
        })
      )
    );
    unwrap(
      await stub.appendThought(
        appendCommand({
          sequenceId: first.sequenceId,
          thought: "A second persisted thought.",
          thoughtNumber: 2,
          now: Date.now() + 1
        })
      )
    );

    const page = unwrap(
      await stub.getHistory({
        sequenceId: first.sequenceId,
        limit: 10,
        cursor: null,
        order: "asc",
        branchId: null,
        maxCharacters: 1,
        now: Date.now() + 2
      })
    );

    expect(page.thoughts).toHaveLength(1);
    expect(page.thoughts[0]?.thought).toContain("deliberately longer");
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(page.thoughts[0]?.ordinal);
  });

  it("records branches and revisions while preserving their full text", async () => {
    const stub = store();
    const first = unwrap(await stub.appendThought(appendCommand()));

    const branch = unwrap(
      await stub.appendThought(
        appendCommand({
          sequenceId: first.sequenceId,
          thought: "Explore the Durable Object alternative.",
          thoughtNumber: 2,
          branchId: "durable-object-alternative",
          branchFromThought: 1,
          now: Date.now() + 1
        })
      )
    );

    const revision = unwrap(
      await stub.appendThought(
        appendCommand({
          sequenceId: first.sequenceId,
          thought: "Revise thought one: application state can be durable while MCP stays stateless.",
          thoughtNumber: 2,
          isRevision: true,
          revisesThought: 1,
          now: Date.now() + 2
        })
      )
    );

    expect(branch.branches).toEqual(["durable-object-alternative"]);
    expect(revision.sequence.branches).toMatchObject([
      {
        branchId: "durable-object-alternative",
        parentBranchId: MAIN_BRANCH_ID,
        branchFromThought: 1
      }
    ]);

    const branchHistory = unwrap(
      await stub.getHistory({
        sequenceId: first.sequenceId,
        limit: 20,
        cursor: null,
        order: "asc",
        branchId: "durable-object-alternative",
        maxCharacters: DEFAULT_HISTORY_CHARACTERS,
        now: Date.now() + 3
      })
    );
    expect(branchHistory.thoughts.map((entry) => entry.thought)).toEqual([
      "Explore the Durable Object alternative."
    ]);

    const repeatedNumber = unwrap(
      await stub.getThought({
        sequenceId: first.sequenceId,
        thoughtId: null,
        ordinal: null,
        thoughtNumber: 2,
        branchId: null,
        limit: 10,
        now: Date.now() + 4
      })
    );
    expect(repeatedNumber.thoughts.map((entry) => entry.thought)).toEqual([
      "Explore the Durable Object alternative.",
      "Revise thought one: application state can be durable while MCP stays stateless."
    ]);
  });

  it("resolves revision targets against the calling branch, not the whole sequence", async () => {
    const stub = store();
    const first = unwrap(await stub.appendThought(appendCommand()));
    unwrap(
      await stub.appendThought(
        appendCommand({
          sequenceId: first.sequenceId,
          thought: "Second main thought.",
          thoughtNumber: 2,
          now: Date.now() + 1
        })
      )
    );

    // Thought 3 exists ONLY inside a branch.
    unwrap(
      await stub.appendThought(
        appendCommand({
          sequenceId: first.sequenceId,
          thought: "Branch-only thought three.",
          thoughtNumber: 3,
          branchId: "alt",
          branchFromThought: 2,
          now: Date.now() + 2
        })
      )
    );

    // Revising #3 from the MAIN path must fail: main has no thought 3.
    const crossBranchRevision = await stub.appendThought(
      appendCommand({
        sequenceId: first.sequenceId,
        thought: "Attempt to revise a branch thought from main.",
        thoughtNumber: 3,
        isRevision: true,
        revisesThought: 3,
        now: Date.now() + 3
      })
    );
    expect(crossBranchRevision).toMatchObject({
      ok: false,
      error: { code: "revision_target_not_found" }
    });

    // Revising an inherited pre-fork thought (#1, lives on main) from inside
    // the branch must succeed: ancestors are visible up to the fork point.
    const inheritedRevision = unwrap(
      await stub.appendThought(
        appendCommand({
          sequenceId: first.sequenceId,
          thought: "Revise the inherited first thought from inside the branch.",
          thoughtNumber: 4,
          branchId: "alt",
          isRevision: true,
          revisesThought: 1,
          now: Date.now() + 4
        })
      )
    );
    expect(inheritedRevision.thought.branchId).toBe("alt");
  });

  it("disambiguates fork points with branchFromBranchId and records branch parentage", async () => {
    const stub = store();
    const first = unwrap(await stub.appendThought(appendCommand()));
    unwrap(
      await stub.appendThought(
        appendCommand({
          sequenceId: first.sequenceId,
          thought: "Second main thought.",
          thoughtNumber: 2,
          now: Date.now() + 1
        })
      )
    );

    // Two parallel branches both containing a thought number 3.
    for (const branchId of ["balanced", "left-heavy"]) {
      unwrap(
        await stub.appendThought(
          appendCommand({
            sequenceId: first.sequenceId,
            thought: `Thought three on ${branchId}.`,
            thoughtNumber: 3,
            branchId,
            branchFromThought: 2,
            now: Date.now() + 2
          })
        )
      );
    }

    // Forking at #3 without a qualifier must fail: main has no thought 3.
    const ambiguous = await stub.appendThought(
      appendCommand({
        sequenceId: first.sequenceId,
        thought: "Fork without naming the owning branch.",
        thoughtNumber: 4,
        branchId: "nested",
        branchFromThought: 3,
        now: Date.now() + 3
      })
    );
    expect(ambiguous).toMatchObject({
      ok: false,
      error: { code: "branch_point_not_found" }
    });

    // Naming the owner makes the same fork explicit and records parentage.
    const nested = unwrap(
      await stub.appendThought(
        appendCommand({
          sequenceId: first.sequenceId,
          thought: "Nested fork from inside left-heavy.",
          thoughtNumber: 4,
          branchId: "nested",
          branchFromThought: 3,
          branchFromBranchId: "left-heavy",
          now: Date.now() + 4
        })
      )
    );
    expect(nested.sequence.branches).toMatchObject([
      { branchId: "balanced", parentBranchId: MAIN_BRANCH_ID, branchFromThought: 2 },
      { branchId: "left-heavy", parentBranchId: MAIN_BRANCH_ID, branchFromThought: 2 },
      { branchId: "nested", parentBranchId: "left-heavy", branchFromThought: 3 }
    ]);

    // A contradictory parent claim on an existing branch is a conflict.
    const conflict = await stub.appendThought(
      appendCommand({
        sequenceId: first.sequenceId,
        thought: "Claim nested forks from balanced instead.",
        thoughtNumber: 5,
        branchId: "nested",
        branchFromBranchId: "balanced",
        now: Date.now() + 5
      })
    );
    expect(conflict).toMatchObject({ ok: false, error: { code: "branch_conflict" } });
  });

  it("accepts a repeated branchFromBranchId that resolves to the stored parent", async () => {
    const stub = store();
    const first = unwrap(await stub.appendThought(appendCommand()));
    for (let n = 2; n <= 5; n += 1) {
      unwrap(
        await stub.appendThought(
          appendCommand({
            sequenceId: first.sequenceId,
            thought: `Main thought ${n}.`,
            thoughtNumber: n,
            totalThoughts: 5,
            now: Date.now() + n
          })
        )
      );
    }
    // Branch B forks from main at 5; its own numbering starts at 6.
    unwrap(
      await stub.appendThought(
        appendCommand({
          sequenceId: first.sequenceId,
          thought: "B six.",
          thoughtNumber: 6,
          totalThoughts: 6,
          branchId: "b",
          branchFromThought: 5,
          now: Date.now() + 6
        })
      )
    );
    // Branch C is created claiming a fork "from b at 3" — thought 3 actually
    // lives on main (inherited), so the stored parent collapses to main.
    unwrap(
      await stub.appendThought(
        appendCommand({
          sequenceId: first.sequenceId,
          thought: "C four.",
          thoughtNumber: 4,
          totalThoughts: 6,
          branchId: "c",
          branchFromThought: 3,
          branchFromBranchId: "b",
          now: Date.now() + 7
        })
      )
    );
    // A consistent client repeats its original claim on the continuation.
    // That claim resolves to the stored parent, so it must NOT conflict.
    const continuation = unwrap(
      await stub.appendThought(
        appendCommand({
          sequenceId: first.sequenceId,
          thought: "C five.",
          thoughtNumber: 5,
          totalThoughts: 6,
          branchId: "c",
          branchFromBranchId: "b",
          now: Date.now() + 8
        })
      )
    );
    expect(continuation.thought.branchId).toBe("c");
    expect(continuation.sequence.branches).toMatchObject([
      { branchId: "b", parentBranchId: MAIN_BRANCH_ID, branchFromThought: 5 },
      { branchId: "c", parentBranchId: MAIN_BRANCH_ID, branchFromThought: 3 }
    ]);
  });

  it("flags reopened sequences and reused thought numbers without rejecting them", async () => {
    const stub = store();
    const first = unwrap(
      await stub.appendThought(appendCommand({ nextThoughtNeeded: false, totalThoughts: 1 }))
    );
    expect(first.reopened).toBe(false);
    expect(first.numberReused).toBe(false);

    const afterCompletion = unwrap(
      await stub.appendThought(
        appendCommand({
          sequenceId: first.sequenceId,
          thought: "Continue after completion.",
          thoughtNumber: 2,
          totalThoughts: 2,
          now: Date.now() + 1
        })
      )
    );
    expect(afterCompletion.reopened).toBe(true);
    expect(afterCompletion.numberReused).toBe(false);

    const duplicateNumber = unwrap(
      await stub.appendThought(
        appendCommand({
          sequenceId: first.sequenceId,
          thought: "Accidentally reuse thought number two.",
          thoughtNumber: 2,
          totalThoughts: 2,
          now: Date.now() + 2
        })
      )
    );
    expect(duplicateNumber.numberReused).toBe(true);
  });

  it("lists and permanently deletes sequences, then reinitializes empty storage", async () => {
    const stub = store();
    const created = unwrap(
      await stub.appendThought(
        appendCommand({
          sequenceTitle: "Disposable sequence",
          nextThoughtNeeded: false
        })
      )
    );

    const listed = unwrap(
      await stub.listSequences({ limit: 20, offset: 0, status: "completed", now: Date.now() + 1 })
    );
    expect(listed.total).toBe(1);
    expect(listed.sequences[0]?.sequenceId).toBe(created.sequenceId);
    expect(listed.sequences[0]?.lastThoughtPreview).toBe("Identify the constraints.");

    const deleted = unwrap(
      await stub.deleteSequence({ sequenceId: created.sequenceId, now: Date.now() + 2 })
    );
    expect(deleted).toEqual({
      sequenceId: created.sequenceId,
      deleted: true,
      deletedThoughts: 1
    });

    const deletedAgain = unwrap(
      await stub.deleteSequence({ sequenceId: created.sequenceId, now: Date.now() + 3 })
    );
    expect(deletedAgain.deleted).toBe(false);

    const replacement = unwrap(
      await stub.appendThought(
        appendCommand({ thought: "Storage was recreated after complete deletion." })
      )
    );
    expect(replacement.thought.thought).toContain("recreated");
  });
});
