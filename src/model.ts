export const MAIN_BRANCH_ID = "main";
export const MAX_THOUGHT_TEXT_LENGTH = 20_000;
export const MAX_SEQUENCE_TITLE_LENGTH = 160;
export const MAX_BRANCH_ID_LENGTH = 128;
export const MAX_CLIENT_REQUEST_ID_LENGTH = 128;
export const MAX_SEQUENCE_ID_LENGTH = 80;
export const MAX_THOUGHT_ID_LENGTH = 96;
export const MAX_THOUGHT_NUMBER = 1_000_000;
export const MAX_RETURN_HISTORY_LIMIT = 25;
export const MAX_RETURN_HISTORY_CHARACTERS = 100_000;
export const MAX_HISTORY_PAGE_SIZE = 100;
export const MAX_HISTORY_CHARACTERS = 250_000;
export const DEFAULT_HISTORY_CHARACTERS = 60_000;

export type ThoughtRecord = {
  id: string;
  ordinal: number;
  sequenceId: string;
  thought: string;
  thoughtNumber: number;
  totalThoughts: number;
  nextThoughtNeeded: boolean;
  isRevision: boolean;
  revisesThought: number | null;
  branchFromThought: number | null;
  branchId: string;
  needsMoreThoughts: boolean;
  clientRequestId: string | null;
  createdAt: string;
};

export type BranchSummary = {
  branchId: string;
  parentBranchId: string;
  branchFromThought: number;
  createdAt: string;
};

export type SequenceSummary = {
  sequenceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  completed: boolean;
  thoughtHistoryLength: number;
  lastThoughtNumber: number;
  totalThoughts: number;
  lastThoughtPreview: string;
  branches: BranchSummary[];
};

export type AppendThoughtCommand = {
  sequenceId: string | null;
  sequenceTitle: string | null;
  thought: string;
  nextThoughtNeeded: boolean;
  thoughtNumber: number;
  totalThoughts: number;
  isRevision: boolean;
  revisesThought: number | null;
  branchFromThought: number | null;
  branchFromBranchId: string | null;
  branchId: string;
  needsMoreThoughts: boolean;
  clientRequestId: string | null;
  returnHistoryLimit: number;
  now: number;
};

export type AppendThoughtResult = {
  sequenceId: string;
  thoughtNumber: number;
  totalThoughts: number;
  nextThoughtNeeded: boolean;
  branches: string[];
  thoughtHistoryLength: number;
  sequence: SequenceSummary;
  thought: ThoughtRecord;
  recentThoughts: ThoughtRecord[];
  historyTruncated: boolean;
  deduplicated: boolean;
  reopened: boolean;
  numberReused: boolean;
};

export type GetSequenceStateCommand = {
  sequenceId: string;
  now: number;
};

export type SequenceState = {
  sequenceId: string;
  completed: boolean;
  thoughtHistoryLength: number;
  lastThoughtNumber: number;
  totalThoughts: number;
};

export type GetHistoryCommand = {
  sequenceId: string;
  limit: number;
  cursor: number | null;
  order: "asc" | "desc";
  branchId: string | null;
  maxCharacters: number;
  now: number;
};

export type GetHistoryResult = {
  sequence: SequenceSummary;
  thoughts: ThoughtRecord[];
  matchingThoughtCount: number;
  hasMore: boolean;
  nextCursor: number | null;
  order: "asc" | "desc";
  branchId: string | null;
};

export type GetThoughtCommand = {
  sequenceId: string;
  thoughtId: string | null;
  ordinal: number | null;
  thoughtNumber: number | null;
  branchId: string | null;
  limit: number;
  now: number;
};

export type GetThoughtResult = {
  sequence: SequenceSummary;
  thoughts: ThoughtRecord[];
  truncated: boolean;
};

export type ListSequencesCommand = {
  limit: number;
  offset: number;
  status: "all" | "active" | "completed";
  now: number;
};

export type ListSequencesResult = {
  sequences: SequenceSummary[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export type DeleteSequenceCommand = {
  sequenceId: string;
  now: number;
};

export type DeleteSequenceResult = {
  sequenceId: string;
  deleted: boolean;
  deletedThoughts: number;
};

export type StoreErrorCode =
  | "sequence_not_found"
  | "thought_not_found"
  | "branch_not_found"
  | "branch_point_not_found"
  | "branch_conflict"
  | "branch_id_required"
  | "revision_target_required"
  | "revision_target_not_found"
  | "idempotency_conflict"
  | "invalid_input"
  | "storage_error";

export type StoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: StoreErrorCode; message: string } };

export function createSequenceId(): string {
  return `seq_${crypto.randomUUID()}`;
}

export function createThoughtId(): string {
  return `thought_${crypto.randomUUID()}`;
}

export function normalizeTitle(value: string): string {
  const oneLine = value.replace(/\s+/gu, " ").trim();
  if (oneLine.length <= MAX_SEQUENCE_TITLE_LENGTH) return oneLine;
  return `${oneLine.slice(0, MAX_SEQUENCE_TITLE_LENGTH - 1).trimEnd()}…`;
}

export function thoughtPreview(value: string, limit = 240): string {
  const oneLine = value.replace(/\s+/gu, " ").trim();
  if (oneLine.length <= limit) return oneLine;
  return `${oneLine.slice(0, limit - 1).trimEnd()}…`;
}
