import { DurableObject } from "cloudflare:workers";
import { thoughtRetentionDays, type WorkerSettings } from "./config";
import {
  MAIN_BRANCH_ID,
  MAX_BRANCH_ID_LENGTH,
  MAX_CLIENT_REQUEST_ID_LENGTH,
  MAX_HISTORY_CHARACTERS,
  MAX_HISTORY_PAGE_SIZE,
  MAX_RETURN_HISTORY_CHARACTERS,
  MAX_RETURN_HISTORY_LIMIT,
  MAX_SEQUENCE_ID_LENGTH,
  MAX_SEQUENCE_TITLE_LENGTH,
  MAX_THOUGHT_ID_LENGTH,
  MAX_THOUGHT_NUMBER,
  MAX_THOUGHT_TEXT_LENGTH,
  createSequenceId,
  createThoughtId,
  normalizeTitle,
  thoughtPreview,
  type AppendThoughtCommand,
  type AppendThoughtResult,
  type BranchSummary,
  type DeleteSequenceCommand,
  type DeleteSequenceResult,
  type GetHistoryCommand,
  type GetHistoryResult,
  type GetSequenceStateCommand,
  type GetThoughtCommand,
  type GetThoughtResult,
  type ListSequencesCommand,
  type ListSequencesResult,
  type SequenceState,
  type SequenceSummary,
  type StoreErrorCode,
  type StoreResult,
  type ThoughtRecord
} from "./model";

type SqlBinding = string | number | null;

type SequenceRow = {
  sequence_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  completed: number;
  thought_count: number;
  last_thought_number: number;
  total_thoughts: number;
  last_thought_preview: string;
};

type ThoughtRow = {
  ordinal: number;
  thought_id: string;
  sequence_id: string;
  thought_number: number;
  total_thoughts: number;
  thought: string;
  next_thought_needed: number;
  is_revision: number;
  revises_thought: number | null;
  branch_from_thought: number | null;
  branch_id: string;
  needs_more_thoughts: number;
  client_request_id: string | null;
  request_fingerprint: string | null;
  created_at: number;
};

type BranchRow = {
  branch_id: string;
  parent_branch_id: string | null;
  branch_from_thought: number;
  created_at: number;
};

type CountRow = { count: number };
type MinExpiryRow = { next_expiry: number | null };
type SettingRow = { value: string };

const DAY_MS = 86_400_000;
const encoder = new TextEncoder();
const SEQUENCE_ID_PATTERN = /^seq_[A-Za-z0-9-]+$/u;
const THOUGHT_ID_PATTERN = /^thought_[A-Za-z0-9-]+$/u;

function ok<T>(value: T): StoreResult<T> {
  return { ok: true, value };
}

function failure<T>(code: StoreErrorCode, message: string): StoreResult<T> {
  return { ok: false, error: { code, message } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validPositiveInteger(value: number, max = MAX_THOUGHT_NUMBER): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= max;
}

export class ThoughtStore extends DurableObject<WorkerSettings> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: WorkerSettings) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    // Durable Object SQLite always enforces foreign keys; PRAGMA foreign_keys
    // and PRAGMA user_version are not authorized there (SQLITE_AUTH), so the
    // schema version lives in store_settings instead.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sequences (
        sequence_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
        thought_count INTEGER NOT NULL,
        last_thought_number INTEGER NOT NULL,
        total_thoughts INTEGER NOT NULL,
        last_thought_preview TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS thoughts (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        thought_id TEXT NOT NULL UNIQUE,
        sequence_id TEXT NOT NULL,
        thought_number INTEGER NOT NULL,
        total_thoughts INTEGER NOT NULL,
        thought TEXT NOT NULL,
        next_thought_needed INTEGER NOT NULL CHECK (next_thought_needed IN (0, 1)),
        is_revision INTEGER NOT NULL CHECK (is_revision IN (0, 1)),
        revises_thought INTEGER,
        branch_from_thought INTEGER,
        branch_id TEXT NOT NULL,
        needs_more_thoughts INTEGER NOT NULL CHECK (needs_more_thoughts IN (0, 1)),
        client_request_id TEXT,
        request_fingerprint TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (sequence_id) REFERENCES sequences(sequence_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS branches (
        sequence_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        branch_from_thought INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (sequence_id, branch_id),
        FOREIGN KEY (sequence_id) REFERENCES sequences(sequence_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS store_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_thoughts_sequence_ordinal
        ON thoughts (sequence_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_thoughts_sequence_number
        ON thoughts (sequence_id, thought_number);
      CREATE INDEX IF NOT EXISTS idx_thoughts_sequence_branch_ordinal
        ON thoughts (sequence_id, branch_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_sequences_updated
        ON sequences (updated_at DESC, sequence_id);
      CREATE INDEX IF NOT EXISTS idx_sequences_expiry
        ON sequences (expires_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_client_request
        ON thoughts (client_request_id)
        WHERE client_request_id IS NOT NULL;
    `);

    const columns = this.sql
      .exec("PRAGMA table_info(thoughts)")
      .toArray() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "request_fingerprint")) {
      this.sql.exec("ALTER TABLE thoughts ADD COLUMN request_fingerprint TEXT");
    }

    // v3: branches remember which branch owns their fork point, so nested
    // branch ancestry is reconstructable. NULL means the main path.
    const branchColumns = this.sql
      .exec("PRAGMA table_info(branches)")
      .toArray() as unknown as Array<{ name: string }>;
    if (!branchColumns.some((column) => column.name === "parent_branch_id")) {
      this.sql.exec("ALTER TABLE branches ADD COLUMN parent_branch_id TEXT");
    }
    this.backfillBranchParentage();

    this.sql.exec(
      `INSERT INTO store_settings (key, value) VALUES ('schema_version', '3')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
  }

  // One-time best-effort repair for branches created before schema v3, whose
  // parentage was never recorded (pre-v3 validation was sequence-wide, so a
  // branch could fork from a thought living on any branch). When exactly one
  // non-main branch owns the fork thought, adopt it as the parent; when the
  // owner is main or ambiguous, leave NULL (= main), because the original
  // provenance was never stored and cannot be reconstructed.
  private backfillBranchParentage(): void {
    const done = this.oneOrNull<SettingRow>(
      "SELECT value FROM store_settings WHERE key = 'branch_parentage_backfilled'"
    );
    if (done) return;

    const orphans = this.rows<{
      sequence_id: string;
      branch_id: string;
      branch_from_thought: number;
    }>("SELECT sequence_id, branch_id, branch_from_thought FROM branches WHERE parent_branch_id IS NULL");

    for (const orphan of orphans) {
      if (
        this.thoughtNumberOnBranch(
          orphan.sequence_id,
          MAIN_BRANCH_ID,
          orphan.branch_from_thought
        )
      ) {
        continue;
      }
      const owners = this.rows<{ branch_id: string }>(
        `SELECT DISTINCT branch_id FROM thoughts
         WHERE sequence_id = ? AND thought_number = ? AND branch_id NOT IN (?, ?)`,
        orphan.sequence_id,
        orphan.branch_from_thought,
        MAIN_BRANCH_ID,
        orphan.branch_id
      );
      if (owners.length === 1) {
        this.sql.exec(
          "UPDATE branches SET parent_branch_id = ? WHERE sequence_id = ? AND branch_id = ?",
          owners[0]!.branch_id,
          orphan.sequence_id,
          orphan.branch_id
        );
      }
    }

    this.sql.exec(
      `INSERT INTO store_settings (key, value) VALUES ('branch_parentage_backfilled', '1')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
  }

  private rows<T>(query: string, ...bindings: SqlBinding[]): T[] {
    return this.sql.exec(query, ...bindings).toArray() as unknown as T[];
  }

  private oneOrNull<T>(query: string, ...bindings: SqlBinding[]): T | null {
    return this.rows<T>(query, ...bindings)[0] ?? null;
  }

  private count(query: string, ...bindings: SqlBinding[]): number {
    return this.oneOrNull<CountRow>(query, ...bindings)?.count ?? 0;
  }

  private async prepare(now: number): Promise<void> {
    this.ensureSchema();
    const retentionDays = thoughtRetentionDays(this.env);
    const configuredRetention = String(retentionDays);
    const storedRetention = this.oneOrNull<SettingRow>(
      "SELECT value FROM store_settings WHERE key = 'retention_days'"
    )?.value;

    if (storedRetention !== configuredRetention) {
      this.ctx.storage.transactionSync(() => {
        if (retentionDays === 0) {
          this.sql.exec("UPDATE sequences SET expires_at = NULL WHERE expires_at IS NOT NULL");
        } else {
          this.sql.exec(
            "UPDATE sequences SET expires_at = updated_at + ?",
            retentionDays * DAY_MS
          );
        }
        this.sql.exec(
          `INSERT INTO store_settings (key, value) VALUES ('retention_days', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          configuredRetention
        );
      });
    }

    if (retentionDays === 0) {
      if ((await this.ctx.storage.getAlarm()) !== null) {
        await this.ctx.storage.deleteAlarm();
      }
      return;
    }

    this.purgeExpired(now);
    await this.scheduleNextAlarm();
  }

  private purgeExpired(now: number): number {
    const expiredCount = this.count(
      "SELECT COUNT(*) AS count FROM sequences WHERE expires_at IS NOT NULL AND expires_at <= ?",
      now
    );
    if (expiredCount === 0) return 0;

    this.sql.exec(
      "DELETE FROM sequences WHERE expires_at IS NOT NULL AND expires_at <= ?",
      now
    );
    return expiredCount;
  }

  private async scheduleNextAlarm(): Promise<void> {
    const row = this.oneOrNull<MinExpiryRow>(
      "SELECT MIN(expires_at) AS next_expiry FROM sequences WHERE expires_at IS NOT NULL"
    );
    if (row === null || row.next_expiry === null) {
      if ((await this.ctx.storage.getAlarm()) !== null) {
        await this.ctx.storage.deleteAlarm();
      }
      return;
    }
    await this.ctx.storage.setAlarm(row.next_expiry);
  }

  private sequenceRow(sequenceId: string): SequenceRow | null {
    return this.oneOrNull<SequenceRow>(
      "SELECT * FROM sequences WHERE sequence_id = ?",
      sequenceId
    );
  }

  private thoughtRowById(thoughtId: string): ThoughtRow | null {
    return this.oneOrNull<ThoughtRow>(
      "SELECT * FROM thoughts WHERE thought_id = ?",
      thoughtId
    );
  }

  private thoughtRowByClientRequestId(clientRequestId: string): ThoughtRow | null {
    return this.oneOrNull<ThoughtRow>(
      "SELECT * FROM thoughts WHERE client_request_id = ?",
      clientRequestId
    );
  }

  private branchRow(sequenceId: string, branchId: string): BranchRow | null {
    return this.oneOrNull<BranchRow>(
      `SELECT branch_id, parent_branch_id, branch_from_thought, created_at
       FROM branches WHERE sequence_id = ? AND branch_id = ?`,
      sequenceId,
      branchId
    );
  }

  private thoughtNumberOnBranch(
    sequenceId: string,
    branchId: string,
    thoughtNumber: number
  ): boolean {
    return (
      this.count(
        `SELECT COUNT(*) AS count FROM thoughts
         WHERE sequence_id = ? AND branch_id = ? AND thought_number = ?`,
        sequenceId,
        branchId,
        thoughtNumber
      ) > 0
    );
  }

  // Thought numbers are branch-scoped, so a bare integer reference is only
  // meaningful relative to a branch. A branch sees its own thoughts plus its
  // ancestors' thoughts up to each fork point; the nearest scope wins.
  // Returns the branch that owns the referenced thought, or null.
  private resolveThoughtInChain(
    sequenceId: string,
    startBranchId: string,
    thoughtNumber: number,
    initialCutoff: number | null = null
  ): string | null {
    let branchId = startBranchId;
    let cutoff = initialCutoff ?? Number.MAX_SAFE_INTEGER;
    for (let depth = 0; depth < 64; depth += 1) {
      if (
        thoughtNumber <= cutoff &&
        this.thoughtNumberOnBranch(sequenceId, branchId, thoughtNumber)
      ) {
        return branchId;
      }
      if (branchId === MAIN_BRANCH_ID) return null;
      const branch = this.branchRow(sequenceId, branchId);
      if (!branch) return null;
      cutoff = Math.min(cutoff, branch.branch_from_thought);
      branchId = branch.parent_branch_id ?? MAIN_BRANCH_ID;
    }
    return null;
  }

  private toThought(row: ThoughtRow): ThoughtRecord {
    return {
      id: row.thought_id,
      ordinal: row.ordinal,
      sequenceId: row.sequence_id,
      thought: row.thought,
      thoughtNumber: row.thought_number,
      totalThoughts: row.total_thoughts,
      nextThoughtNeeded: row.next_thought_needed === 1,
      isRevision: row.is_revision === 1,
      revisesThought: row.revises_thought,
      branchFromThought: row.branch_from_thought,
      branchId: row.branch_id,
      needsMoreThoughts: row.needs_more_thoughts === 1,
      clientRequestId: row.client_request_id,
      createdAt: new Date(row.created_at).toISOString()
    };
  }

  private branches(sequenceId: string): BranchSummary[] {
    return this.rows<BranchRow>(
      `SELECT branch_id, parent_branch_id, branch_from_thought, created_at
       FROM branches WHERE sequence_id = ?
       ORDER BY created_at ASC, branch_id ASC`,
      sequenceId
    ).map((row) => ({
      branchId: row.branch_id,
      parentBranchId: row.parent_branch_id ?? MAIN_BRANCH_ID,
      branchFromThought: row.branch_from_thought,
      createdAt: new Date(row.created_at).toISOString()
    }));
  }

  private toSequence(row: SequenceRow): SequenceSummary {
    return {
      sequenceId: row.sequence_id,
      title: row.title,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
      completed: row.completed === 1,
      thoughtHistoryLength: row.thought_count,
      lastThoughtNumber: row.last_thought_number,
      totalThoughts: row.total_thoughts,
      lastThoughtPreview: row.last_thought_preview,
      branches: this.branches(row.sequence_id)
    };
  }

  private recentThoughts(sequenceId: string, limit: number): ThoughtRecord[] {
    if (limit === 0) return [];

    const candidates = this.rows<ThoughtRow>(
      "SELECT * FROM thoughts WHERE sequence_id = ? ORDER BY ordinal DESC LIMIT ?",
      sequenceId,
      limit
    );
    const included: ThoughtRow[] = [];
    let characters = 0;

    for (const row of candidates) {
      const cost = row.thought.length;
      if (included.length > 0 && characters + cost > MAX_RETURN_HISTORY_CHARACTERS) break;
      included.push(row);
      characters += cost;
    }

    return included.reverse().map((row) => this.toThought(row));
  }

  private appendOutput(
    thoughtRow: ThoughtRow,
    returnHistoryLimit: number,
    deduplicated: boolean
  ): Omit<AppendThoughtResult, "reopened" | "numberReused"> {
    const sequenceRow = this.sequenceRow(thoughtRow.sequence_id);
    if (!sequenceRow) {
      throw new Error("Sequence disappeared while constructing the append result.");
    }
    const sequence = this.toSequence(sequenceRow);
    const recentThoughts = this.recentThoughts(thoughtRow.sequence_id, returnHistoryLimit);
    const thought = this.toThought(thoughtRow);
    return {
      sequenceId: sequence.sequenceId,
      thoughtNumber: thought.thoughtNumber,
      totalThoughts: thought.totalThoughts,
      nextThoughtNeeded: thought.nextThoughtNeeded,
      branches: sequence.branches.map((branch) => branch.branchId),
      thoughtHistoryLength: sequence.thoughtHistoryLength,
      sequence,
      thought,
      recentThoughts,
      historyTruncated: sequence.thoughtHistoryLength > recentThoughts.length,
      deduplicated
    };
  }

  // clientRequestId is not exposed on the public tool surface, so stored
  // fingerprints are currently unreachable dead state. If idempotency keys
  // are ever exposed, fingerprints must become versioned: rows written
  // before schema v3 hashed a canonical array without branchFromBranchId.
  private async requestFingerprint(command: AppendThoughtCommand): Promise<string> {
    const canonical = JSON.stringify([
      command.sequenceTitle === null ? null : normalizeTitle(command.sequenceTitle),
      command.thought,
      command.nextThoughtNeeded,
      command.thoughtNumber,
      Math.max(command.totalThoughts, command.thoughtNumber),
      command.isRevision,
      command.revisesThought,
      command.branchFromThought,
      command.branchFromBranchId,
      command.branchId,
      command.needsMoreThoughts
    ]);
    const bytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(canonical))
    );
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private duplicateMatches(
    command: AppendThoughtCommand,
    row: ThoughtRow,
    requestFingerprint: string
  ): boolean {
    if (command.sequenceId !== null && command.sequenceId !== row.sequence_id) return false;
    if (row.request_fingerprint !== null) {
      return row.request_fingerprint === requestFingerprint;
    }

    const adjustedTotalThoughts = Math.max(command.totalThoughts, command.thoughtNumber);
    return (
      command.thought === row.thought &&
      command.thoughtNumber === row.thought_number &&
      adjustedTotalThoughts === row.total_thoughts &&
      command.nextThoughtNeeded === (row.next_thought_needed === 1) &&
      command.isRevision === (row.is_revision === 1) &&
      command.revisesThought === row.revises_thought &&
      command.branchFromThought === row.branch_from_thought &&
      command.branchId === row.branch_id &&
      command.needsMoreThoughts === (row.needs_more_thoughts === 1)
    );
  }

  private validateAppend(
    command: AppendThoughtCommand,
    sequence: SequenceRow | null
  ): StoreResult<{ forkParentBranchId: string | null }> {
    if (
      command.sequenceId !== null &&
      (command.sequenceId.length > MAX_SEQUENCE_ID_LENGTH ||
        !SEQUENCE_ID_PATTERN.test(command.sequenceId))
    ) {
      return failure("invalid_input", "sequenceId is not a valid server-issued sequence ID.");
    }
    if (
      command.sequenceTitle !== null &&
      (command.sequenceTitle.trim().length === 0 ||
        command.sequenceTitle.length > MAX_SEQUENCE_TITLE_LENGTH)
    ) {
      return failure(
        "invalid_input",
        `sequenceTitle must contain 1-${MAX_SEQUENCE_TITLE_LENGTH} characters.`
      );
    }
    if (
      command.thought.trim().length === 0 ||
      command.thought.length > MAX_THOUGHT_TEXT_LENGTH
    ) {
      return failure(
        "invalid_input",
        `thought must contain 1-${MAX_THOUGHT_TEXT_LENGTH} characters.`
      );
    }
    if (
      !validPositiveInteger(command.thoughtNumber) ||
      !validPositiveInteger(command.totalThoughts) ||
      (command.revisesThought !== null && !validPositiveInteger(command.revisesThought)) ||
      (command.branchFromThought !== null && !validPositiveInteger(command.branchFromThought))
    ) {
      return failure(
        "invalid_input",
        `thought counters must be integers from 1 through ${MAX_THOUGHT_NUMBER}.`
      );
    }
    if (
      command.branchId.trim().length === 0 ||
      command.branchId.length > MAX_BRANCH_ID_LENGTH
    ) {
      return failure(
        "invalid_input",
        `branchId must contain 1-${MAX_BRANCH_ID_LENGTH} characters.`
      );
    }
    if (
      command.branchFromBranchId !== null &&
      (command.branchFromBranchId.trim().length === 0 ||
        command.branchFromBranchId.length > MAX_BRANCH_ID_LENGTH)
    ) {
      return failure(
        "invalid_input",
        `branchFromBranchId must contain 1-${MAX_BRANCH_ID_LENGTH} characters.`
      );
    }
    if (
      command.clientRequestId !== null &&
      (command.clientRequestId.trim().length === 0 ||
        command.clientRequestId.length > MAX_CLIENT_REQUEST_ID_LENGTH)
    ) {
      return failure(
        "invalid_input",
        `clientRequestId must contain 1-${MAX_CLIENT_REQUEST_ID_LENGTH} characters.`
      );
    }
    if (
      !Number.isSafeInteger(command.returnHistoryLimit) ||
      command.returnHistoryLimit < 0 ||
      command.returnHistoryLimit > MAX_RETURN_HISTORY_LIMIT
    ) {
      return failure(
        "invalid_input",
        `returnHistoryLimit must be an integer from 0 through ${MAX_RETURN_HISTORY_LIMIT}.`
      );
    }
    if (!Number.isSafeInteger(command.now) || command.now < 0) {
      return failure("invalid_input", "now must be a non-negative integer timestamp.");
    }

    if (command.isRevision && command.revisesThought === null) {
      return failure(
        "revision_target_required",
        "revisesThought is required when isRevision is true."
      );
    }
    if (!command.isRevision && command.revisesThought !== null) {
      return failure(
        "invalid_input",
        "revisesThought may only be supplied when isRevision is true."
      );
    }

    if (command.branchFromThought !== null && command.branchId === MAIN_BRANCH_ID) {
      return failure(
        "branch_id_required",
        `A non-${MAIN_BRANCH_ID} branchId is required when branchFromThought is supplied.`
      );
    }

    if (!sequence) {
      if (command.sequenceId !== null) {
        return failure(
          "sequence_not_found",
          `No thought sequence exists with ID ${command.sequenceId}. Omit sequenceId to create one.`
        );
      }
      if (
        command.branchId !== MAIN_BRANCH_ID ||
        command.branchFromThought !== null ||
        command.branchFromBranchId !== null
      ) {
        return failure(
          "branch_point_not_found",
          "A new sequence cannot begin on a branch because its branch point does not exist yet."
        );
      }
      if (command.isRevision) {
        return failure(
          "revision_target_not_found",
          "A new sequence cannot begin with a revision because no earlier thought exists."
        );
      }
      return ok({ forkParentBranchId: null });
    }

    // Thought numbers are branch-scoped, so integer references resolve
    // against the branch being written to (nearest scope wins along its
    // ancestry), never against the whole sequence.
    let forkParentBranchId: string | null = null;
    let revisionScopeStart = command.branchId;
    let revisionScopeCutoff: number | null = null;

    if (command.branchId !== MAIN_BRANCH_ID) {
      const existingBranch = this.branchRow(sequence.sequence_id, command.branchId);
      if (!existingBranch) {
        if (command.branchFromThought === null) {
          return failure(
            "branch_not_found",
            `Branch ${command.branchId} does not exist. Supply branchFromThought to create it.`
          );
        }
        const sourceBranchId = command.branchFromBranchId ?? MAIN_BRANCH_ID;
        if (sourceBranchId === command.branchId) {
          return failure(
            "invalid_input",
            "branchFromBranchId cannot equal the branch being created."
          );
        }
        if (
          sourceBranchId !== MAIN_BRANCH_ID &&
          this.branchRow(sequence.sequence_id, sourceBranchId) === null
        ) {
          return failure(
            "branch_not_found",
            `branchFromBranchId ${sourceBranchId} does not exist in sequence ${sequence.sequence_id}.`
          );
        }
        const forkOwner = this.resolveThoughtInChain(
          sequence.sequence_id,
          sourceBranchId,
          command.branchFromThought
        );
        if (forkOwner === null) {
          const scope =
            sourceBranchId === MAIN_BRANCH_ID
              ? "the main path"
              : `branch ${sourceBranchId} or its ancestors`;
          return failure(
            "branch_point_not_found",
            `Thought number ${command.branchFromThought} does not exist on ${scope}. Use branchFromBranchId to fork from inside another branch.`
          );
        }
        forkParentBranchId = forkOwner;
        revisionScopeStart = forkOwner;
        revisionScopeCutoff = command.branchFromThought;
      } else {
        if (
          command.branchFromThought !== null &&
          command.branchFromThought !== existingBranch.branch_from_thought
        ) {
          return failure(
            "branch_conflict",
            `Branch ${command.branchId} already starts from thought ${existingBranch.branch_from_thought}.`
          );
        }
        // Creation collapses the fork owner to the true ancestor, so a
        // continuation repeating the client's original branchFromBranchId is
        // legitimate whenever that claim RESOLVES to the stored parent —
        // only genuinely contradictory claims are conflicts.
        if (command.branchFromBranchId !== null) {
          const storedParent = existingBranch.parent_branch_id ?? MAIN_BRANCH_ID;
          if (command.branchFromBranchId !== storedParent) {
            const claimResolves = this.resolveThoughtInChain(
              sequence.sequence_id,
              command.branchFromBranchId,
              existingBranch.branch_from_thought
            );
            if (claimResolves !== storedParent) {
              return failure(
                "branch_conflict",
                `Branch ${command.branchId} forks from ${storedParent} at thought ${existingBranch.branch_from_thought}; branchFromBranchId ${command.branchFromBranchId} contradicts that.`
              );
            }
          }
        }
      }
    } else if (command.branchFromBranchId !== null) {
      return failure(
        "invalid_input",
        `branchFromBranchId may only be supplied when writing to a non-${MAIN_BRANCH_ID} branch.`
      );
    }

    if (command.revisesThought !== null) {
      const resolved = this.resolveThoughtInChain(
        sequence.sequence_id,
        revisionScopeStart,
        command.revisesThought,
        revisionScopeCutoff
      );
      if (resolved === null) {
        const scope =
          command.branchId === MAIN_BRANCH_ID
            ? "the main path"
            : `branch ${command.branchId} or its ancestors`;
        return failure(
          "revision_target_not_found",
          `Thought number ${command.revisesThought} does not exist on ${scope} in sequence ${sequence.sequence_id}.`
        );
      }
    }

    return ok({ forkParentBranchId });
  }

  async appendThought(command: AppendThoughtCommand): Promise<StoreResult<AppendThoughtResult>> {
    let requestFingerprint: string | null = null;
    try {
      await this.prepare(command.now);
      requestFingerprint = await this.requestFingerprint(command);

      const requestedSequence =
        command.sequenceId === null ? null : this.sequenceRow(command.sequenceId);
      const validation = this.validateAppend(command, requestedSequence);
      if (!validation.ok) return validation;

      if (command.clientRequestId !== null) {
        const duplicate = this.thoughtRowByClientRequestId(command.clientRequestId);
        if (duplicate) {
          if (!this.duplicateMatches(command, duplicate, requestFingerprint)) {
            return failure(
              "idempotency_conflict",
              `clientRequestId ${command.clientRequestId} was already used for a different write payload.`
            );
          }
          return ok({
            ...this.appendOutput(duplicate, command.returnHistoryLimit, true),
            reopened: false,
            numberReused: false
          });
        }
      }

      const sequenceId = requestedSequence?.sequence_id ?? createSequenceId();
      const thoughtId = createThoughtId();
      const adjustedTotalThoughts = Math.max(command.totalThoughts, command.thoughtNumber);
      const retentionDays = thoughtRetentionDays(this.env);
      const expiresAt = retentionDays === 0 ? null : command.now + retentionDays * DAY_MS;
      const title = normalizeTitle(command.sequenceTitle ?? command.thought);
      const preview = thoughtPreview(command.thought);
      const createsBranch =
        requestedSequence !== null &&
        command.branchId !== MAIN_BRANCH_ID &&
        this.branchRow(sequenceId, command.branchId) === null;
      const reopened = requestedSequence !== null && requestedSequence.completed === 1;
      const numberReused =
        requestedSequence !== null &&
        !command.isRevision &&
        this.thoughtNumberOnBranch(sequenceId, command.branchId, command.thoughtNumber);

      this.ctx.storage.transactionSync(() => {
        if (!requestedSequence) {
          this.sql.exec(
            `INSERT INTO sequences (
              sequence_id, title, created_at, updated_at, expires_at, completed,
              thought_count, last_thought_number, total_thoughts, last_thought_preview
            ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
            sequenceId,
            title,
            command.now,
            command.now,
            expiresAt,
            command.nextThoughtNeeded ? 0 : 1,
            command.thoughtNumber,
            adjustedTotalThoughts,
            preview
          );
        } else {
          const updatedTitle = command.sequenceTitle === null ? requestedSequence.title : title;
          this.sql.exec(
            `UPDATE sequences SET
              title = ?,
              updated_at = ?,
              expires_at = ?,
              completed = ?,
              thought_count = thought_count + 1,
              last_thought_number = ?,
              total_thoughts = ?,
              last_thought_preview = ?
            WHERE sequence_id = ?`,
            updatedTitle,
            command.now,
            expiresAt,
            command.nextThoughtNeeded ? 0 : 1,
            command.thoughtNumber,
            adjustedTotalThoughts,
            preview,
            sequenceId
          );
        }

        if (createsBranch && command.branchFromThought !== null) {
          const parent = validation.value.forkParentBranchId;
          this.sql.exec(
            `INSERT INTO branches
              (sequence_id, branch_id, parent_branch_id, branch_from_thought, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            sequenceId,
            command.branchId,
            parent === null || parent === MAIN_BRANCH_ID ? null : parent,
            command.branchFromThought,
            command.now
          );
        }

        this.sql.exec(
          `INSERT INTO thoughts (
            thought_id, sequence_id, thought_number, total_thoughts, thought,
            next_thought_needed, is_revision, revises_thought, branch_from_thought,
            branch_id, needs_more_thoughts, client_request_id, request_fingerprint, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          thoughtId,
          sequenceId,
          command.thoughtNumber,
          adjustedTotalThoughts,
          command.thought,
          command.nextThoughtNeeded ? 1 : 0,
          command.isRevision ? 1 : 0,
          command.revisesThought,
          command.branchFromThought,
          command.branchId,
          command.needsMoreThoughts ? 1 : 0,
          command.clientRequestId,
          requestFingerprint,
          command.now
        );
      });

      // The append is committed at this point: a failed alarm reschedule is
      // housekeeping and must not report the durable write as a failure. The
      // next request's prepare() reschedules anyway.
      if (retentionDays > 0) {
        try {
          await this.scheduleNextAlarm();
        } catch (error) {
          console.error(
            JSON.stringify({ event: "thought_store_alarm_error", message: errorMessage(error) })
          );
        }
      }

      const inserted = this.thoughtRowById(thoughtId);
      if (!inserted) throw new Error("Inserted thought could not be read back from storage.");

      return ok({
        ...this.appendOutput(inserted, command.returnHistoryLimit, false),
        reopened,
        numberReused
      });
    } catch (error) {
      if (command.clientRequestId !== null) {
        try {
          const duplicate = this.thoughtRowByClientRequestId(command.clientRequestId);
          if (duplicate) {
            const fingerprint = requestFingerprint ?? (await this.requestFingerprint(command));
            if (this.duplicateMatches(command, duplicate, fingerprint)) {
              return ok({
                ...this.appendOutput(duplicate, command.returnHistoryLimit, true),
                reopened: false,
                numberReused: false
              });
            }
            return failure(
              "idempotency_conflict",
              `clientRequestId ${command.clientRequestId} was already used for a different write payload.`
            );
          }
        } catch {
          // Fall through to a storage-safe error.
        }
      }

      console.error(
        JSON.stringify({ event: "thought_store_append_error", message: errorMessage(error) })
      );
      return failure("storage_error", "The thought could not be persisted.");
    }
  }

  async getSequenceState(
    command: GetSequenceStateCommand
  ): Promise<StoreResult<SequenceState>> {
    if (
      command.sequenceId.length > MAX_SEQUENCE_ID_LENGTH ||
      !SEQUENCE_ID_PATTERN.test(command.sequenceId) ||
      !Number.isSafeInteger(command.now) ||
      command.now < 0
    ) {
      return failure("invalid_input", "The sequence-state request failed validation.");
    }

    try {
      await this.prepare(command.now);
      const sequence = this.sequenceRow(command.sequenceId);
      if (!sequence) {
        return failure(
          "sequence_not_found",
          `No thought sequence exists with ID ${command.sequenceId}.`
        );
      }
      return ok({
        sequenceId: sequence.sequence_id,
        completed: sequence.completed === 1,
        thoughtHistoryLength: sequence.thought_count,
        lastThoughtNumber: sequence.last_thought_number,
        totalThoughts: sequence.total_thoughts
      });
    } catch (error) {
      console.error(
        JSON.stringify({ event: "thought_store_state_error", message: errorMessage(error) })
      );
      return failure("storage_error", "The thought sequence state could not be read.");
    }
  }

  async getHistory(command: GetHistoryCommand): Promise<StoreResult<GetHistoryResult>> {
    if (
      command.sequenceId.length > MAX_SEQUENCE_ID_LENGTH ||
      !SEQUENCE_ID_PATTERN.test(command.sequenceId) ||
      !Number.isSafeInteger(command.limit) ||
      command.limit < 1 ||
      command.limit > MAX_HISTORY_PAGE_SIZE ||
      (command.order !== "asc" && command.order !== "desc") ||
      (command.cursor !== null && (!Number.isSafeInteger(command.cursor) || command.cursor < 1)) ||
      (command.branchId !== null &&
        (command.branchId.trim().length === 0 || command.branchId.length > MAX_BRANCH_ID_LENGTH)) ||
      !Number.isSafeInteger(command.maxCharacters) ||
      command.maxCharacters < 1 ||
      command.maxCharacters > MAX_HISTORY_CHARACTERS ||
      !Number.isSafeInteger(command.now) ||
      command.now < 0
    ) {
      return failure("invalid_input", "The history request failed validation.");
    }

    try {
      await this.prepare(command.now);
      const sequenceRow = this.sequenceRow(command.sequenceId);
      if (!sequenceRow) {
        return failure(
          "sequence_not_found",
          `No thought sequence exists with ID ${command.sequenceId}.`
        );
      }

      if (
        command.branchId !== null &&
        command.branchId !== MAIN_BRANCH_ID &&
        this.branchRow(command.sequenceId, command.branchId) === null
      ) {
        return failure("branch_not_found", `Branch ${command.branchId} does not exist.`);
      }

      const conditions = ["sequence_id = ?"];
      const bindings: SqlBinding[] = [command.sequenceId];
      if (command.branchId !== null) {
        conditions.push("branch_id = ?");
        bindings.push(command.branchId);
      }
      if (command.cursor !== null) {
        conditions.push(command.order === "asc" ? "ordinal > ?" : "ordinal < ?");
        bindings.push(command.cursor);
      }

      const countConditions = ["sequence_id = ?"];
      const countBindings: SqlBinding[] = [command.sequenceId];
      if (command.branchId !== null) {
        countConditions.push("branch_id = ?");
        countBindings.push(command.branchId);
      }
      const matchingThoughtCount = this.count(
        `SELECT COUNT(*) AS count FROM thoughts WHERE ${countConditions.join(" AND ")}`,
        ...countBindings
      );

      const candidateRows = this.rows<ThoughtRow>(
        `SELECT * FROM thoughts
         WHERE ${conditions.join(" AND ")}
         ORDER BY ordinal ${command.order === "asc" ? "ASC" : "DESC"}
         LIMIT ?`,
        ...bindings,
        command.limit + 1
      );

      const included: ThoughtRow[] = [];
      let characters = 0;
      for (const row of candidateRows.slice(0, command.limit)) {
        const cost = row.thought.length;
        if (included.length > 0 && characters + cost > command.maxCharacters) break;
        included.push(row);
        characters += cost;
      }

      const hasMore = candidateRows.length > included.length;
      const last = included.at(-1);
      return ok({
        sequence: this.toSequence(sequenceRow),
        thoughts: included.map((row) => this.toThought(row)),
        matchingThoughtCount,
        hasMore,
        nextCursor: hasMore && last ? last.ordinal : null,
        order: command.order,
        branchId: command.branchId
      });
    } catch (error) {
      console.error(
        JSON.stringify({ event: "thought_store_history_error", message: errorMessage(error) })
      );
      return failure("storage_error", "The thought history could not be read.");
    }
  }

  async getThought(command: GetThoughtCommand): Promise<StoreResult<GetThoughtResult>> {
    const selectorCount = [command.thoughtId, command.ordinal, command.thoughtNumber].filter(
      (value) => value !== null
    ).length;
    if (
      command.sequenceId.length > MAX_SEQUENCE_ID_LENGTH ||
      !SEQUENCE_ID_PATTERN.test(command.sequenceId) ||
      selectorCount !== 1 ||
      (command.thoughtId !== null &&
        (command.thoughtId.length > MAX_THOUGHT_ID_LENGTH ||
          !THOUGHT_ID_PATTERN.test(command.thoughtId))) ||
      (command.ordinal !== null && (!Number.isSafeInteger(command.ordinal) || command.ordinal < 1)) ||
      (command.thoughtNumber !== null && !validPositiveInteger(command.thoughtNumber)) ||
      (command.branchId !== null &&
        (command.branchId.trim().length === 0 || command.branchId.length > MAX_BRANCH_ID_LENGTH)) ||
      !Number.isSafeInteger(command.limit) ||
      command.limit < 1 ||
      command.limit > 100 ||
      !Number.isSafeInteger(command.now) ||
      command.now < 0
    ) {
      return failure(
        "invalid_input",
        "Specify exactly one valid thoughtId, ordinal, or thoughtNumber selector."
      );
    }

    try {
      await this.prepare(command.now);
      const sequenceRow = this.sequenceRow(command.sequenceId);
      if (!sequenceRow) {
        return failure(
          "sequence_not_found",
          `No thought sequence exists with ID ${command.sequenceId}.`
        );
      }
      if (
        command.branchId !== null &&
        command.branchId !== MAIN_BRANCH_ID &&
        this.branchRow(command.sequenceId, command.branchId) === null
      ) {
        return failure("branch_not_found", `Branch ${command.branchId} does not exist.`);
      }

      const conditions = ["sequence_id = ?"];
      const bindings: SqlBinding[] = [command.sequenceId];
      if (command.branchId !== null) {
        conditions.push("branch_id = ?");
        bindings.push(command.branchId);
      }

      let queryLimit = 1;
      if (command.thoughtId !== null) {
        conditions.push("thought_id = ?");
        bindings.push(command.thoughtId);
      } else if (command.ordinal !== null) {
        conditions.push("ordinal = ?");
        bindings.push(command.ordinal);
      } else if (command.thoughtNumber !== null) {
        conditions.push("thought_number = ?");
        bindings.push(command.thoughtNumber);
        queryLimit = command.limit + 1;
      }

      const found = this.rows<ThoughtRow>(
        `SELECT * FROM thoughts
         WHERE ${conditions.join(" AND ")}
         ORDER BY ordinal ASC LIMIT ?`,
        ...bindings,
        queryLimit
      );
      if (found.length === 0) {
        return failure("thought_not_found", "No stored thought matches the supplied selector.");
      }

      const thoughts = found.slice(0, command.limit);
      return ok({
        sequence: this.toSequence(sequenceRow),
        thoughts: thoughts.map((row) => this.toThought(row)),
        truncated: found.length > thoughts.length
      });
    } catch (error) {
      console.error(
        JSON.stringify({ event: "thought_store_get_error", message: errorMessage(error) })
      );
      return failure("storage_error", "The thought could not be read.");
    }
  }

  async listSequences(command: ListSequencesCommand): Promise<StoreResult<ListSequencesResult>> {
    if (
      !Number.isSafeInteger(command.limit) ||
      command.limit < 1 ||
      command.limit > 100 ||
      !Number.isSafeInteger(command.offset) ||
      command.offset < 0 ||
      command.offset > 100_000 ||
      !["all", "active", "completed"].includes(command.status) ||
      !Number.isSafeInteger(command.now) ||
      command.now < 0
    ) {
      return failure("invalid_input", "The sequence-list request failed validation.");
    }

    try {
      await this.prepare(command.now);
      const statusCondition =
        command.status === "active"
          ? "completed = 0"
          : command.status === "completed"
            ? "completed = 1"
            : "1 = 1";
      const total = this.count(
        `SELECT COUNT(*) AS count FROM sequences WHERE ${statusCondition}`
      );
      const rows = this.rows<SequenceRow>(
        `SELECT * FROM sequences
         WHERE ${statusCondition}
         ORDER BY updated_at DESC, sequence_id ASC
         LIMIT ? OFFSET ?`,
        command.limit,
        command.offset
      );
      const sequences = rows.map((row) => this.toSequence(row));
      return ok({
        sequences,
        total,
        limit: command.limit,
        offset: command.offset,
        hasMore: command.offset + sequences.length < total
      });
    } catch (error) {
      console.error(
        JSON.stringify({ event: "thought_store_list_error", message: errorMessage(error) })
      );
      return failure("storage_error", "Thought sequences could not be listed.");
    }
  }

  async deleteSequence(command: DeleteSequenceCommand): Promise<StoreResult<DeleteSequenceResult>> {
    if (
      command.sequenceId.length > MAX_SEQUENCE_ID_LENGTH ||
      !SEQUENCE_ID_PATTERN.test(command.sequenceId) ||
      !Number.isSafeInteger(command.now) ||
      command.now < 0
    ) {
      return failure("invalid_input", "The sequence deletion request failed validation.");
    }

    try {
      await this.prepare(command.now);
      const sequence = this.sequenceRow(command.sequenceId);
      if (!sequence) {
        return ok({ sequenceId: command.sequenceId, deleted: false, deletedThoughts: 0 });
      }
      const deletedThoughts = this.count(
        "SELECT COUNT(*) AS count FROM thoughts WHERE sequence_id = ?",
        command.sequenceId
      );

      this.sql.exec("DELETE FROM sequences WHERE sequence_id = ?", command.sequenceId);

      if (this.count("SELECT COUNT(*) AS count FROM sequences") === 0) {
        await this.ctx.storage.deleteAll();
      } else {
        await this.scheduleNextAlarm();
      }

      return ok({
        sequenceId: command.sequenceId,
        deleted: true,
        deletedThoughts
      });
    } catch (error) {
      console.error(
        JSON.stringify({ event: "thought_store_delete_error", message: errorMessage(error) })
      );
      return failure("storage_error", "The thought sequence could not be deleted.");
    }
  }

  async ping(): Promise<{ ok: true; schemaVersion: 3 }> {
    await this.prepare(Date.now());
    return { ok: true, schemaVersion: 3 };
  }

  override async alarm(): Promise<void> {
    this.ensureSchema();
    const retentionDays = thoughtRetentionDays(this.env);
    if (retentionDays === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    this.purgeExpired(Date.now());
    if (this.count("SELECT COUNT(*) AS count FROM sequences") === 0) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.scheduleNextAlarm();
  }
}
