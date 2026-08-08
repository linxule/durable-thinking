import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { WorkerEnv } from "./config";
import {
  DEFAULT_HISTORY_CHARACTERS,
  MAIN_BRANCH_ID,
  MAX_BRANCH_ID_LENGTH,
  MAX_HISTORY_CHARACTERS,
  MAX_HISTORY_PAGE_SIZE,
  MAX_SEQUENCE_ID_LENGTH,
  MAX_THOUGHT_NUMBER,
  MAX_THOUGHT_TEXT_LENGTH,
  type AppendThoughtResult,
  type GetHistoryResult,
  type SequenceSummary,
  type ThoughtRecord
} from "./model";
import { getThoughtStore } from "./store-client";
import thoughtProcessHtml from "./ui/thought-process.html";

export const THOUGHT_APP_URI = "ui://sequential-thinking/process.html";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
const SERVER_VERSION = "3.1.1";

const THOUGHT_TOOL_META = {
  ui: {
    resourceUri: THOUGHT_APP_URI,
    visibility: ["model", "app"]
  }
} as const;

const HISTORY_TOOL_META = {
  ui: {
    visibility: ["model", "app"]
  }
} as const;

const MODEL_ONLY_META = {
  ui: {
    visibility: ["model"]
  }
} as const;

const THOUGHT_APP_RESOURCE_META = {
  ui: {
    csp: {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: []
    },
    prefersBorder: false
  }
} as const;

// A union (not z.preprocess) so JSON-schema conversion keeps the field
// required: preprocess erases required status because its input is unknown,
// which advertised nextThoughtNeeded as optional while the server rejected
// its omission.
const coercedBoolean = z.union([
  z.boolean(),
  z.stringbool({ truthy: ["true"], falsy: ["false"] })
]);

const sequenceIdSchema = z
  .string()
  .min(1)
  .max(MAX_SEQUENCE_ID_LENGTH)
  .regex(/^seq_[A-Za-z0-9-]+$/u)
  .describe("Server-issued sequence identifier. Omit it only for the first thought.");

const sequentialThinkingInputSchema = z.object({
  thought: z
    .string()
    .min(1)
    .max(MAX_THOUGHT_TEXT_LENGTH)
    .describe("The current explicit reasoning, planning, revision, or verification step."),
  nextThoughtNeeded: coercedBoolean.describe("Whether another thought step is needed."),
  thoughtNumber: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_THOUGHT_NUMBER)
    .describe("Current logical thought number."),
  totalThoughts: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_THOUGHT_NUMBER)
    .describe("Current estimate of the total thoughts needed."),
  isRevision: coercedBoolean.optional().describe("Whether this revises earlier thinking."),
  revisesThought: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_THOUGHT_NUMBER)
    .optional()
    .describe("Earlier thought number being reconsidered."),
  branchFromThought: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_THOUGHT_NUMBER)
    .optional()
    .describe("Existing thought number where a new branch begins. Resolved on the main path unless branchFromBranchId names another branch."),
  branchFromBranchId: z
    .string()
    .trim()
    .min(1)
    .max(MAX_BRANCH_ID_LENGTH)
    .optional()
    .describe("Branch that owns branchFromThought when forking from inside another branch. Omit to fork from the main path."),
  branchId: z
    .string()
    .trim()
    .min(1)
    .max(MAX_BRANCH_ID_LENGTH)
    .optional()
    .describe("Branch name. Omit it for the main path."),
  needsMoreThoughts: coercedBoolean
    .optional()
    .describe("Whether the estimate should extend beyond totalThoughts."),
  sequenceId: sequenceIdSchema
    .optional()
    .describe("Pass the value returned by the first call on every continuation.")
});

const sequentialThinkingOutputSchema = z.object({
  sequenceId: sequenceIdSchema,
  thoughtNumber: z.number().int(),
  totalThoughts: z.number().int(),
  thoughtHistoryLength: z.number().int()
});

const historyThoughtSchema = z.object({
  ordinal: z.number().int(),
  thoughtNumber: z.number().int(),
  totalThoughts: z.number().int(),
  thought: z.string(),
  nextThoughtNeeded: z.boolean(),
  isRevision: z.literal(true).optional(),
  revisesThought: z.number().int().optional(),
  branchFromThought: z.number().int().optional(),
  branchId: z.string().optional(),
  needsMoreThoughts: z.literal(true).optional()
});

const branchSummarySchema = z.object({
  branchId: z.string(),
  parentBranchId: z.string(),
  branchFromThought: z.number().int()
});

const compactSequenceSchema = z.object({
  sequenceId: sequenceIdSchema,
  title: z.string(),
  completed: z.boolean(),
  thoughtHistoryLength: z.number().int(),
  lastThoughtNumber: z.number().int(),
  totalThoughts: z.number().int(),
  branches: z.array(branchSummarySchema)
});

const getHistoryInputSchema = z.object({
  sequenceId: sequenceIdSchema,
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_HISTORY_PAGE_SIZE)
    .optional()
    .describe("Maximum entries in this page. Defaults to 50."),
  cursor: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Pass nextCursor from the previous page to continue."),
  order: z
    .enum(["asc", "desc"])
    .optional()
    .describe("Oldest-first or newest-first. Defaults to asc."),
  branchId: z
    .string()
    .trim()
    .min(1)
    .max(MAX_BRANCH_ID_LENGTH)
    .optional()
    .describe(`Optional exact branch filter. Use ${MAIN_BRANCH_ID} for the main path.`),
  maxCharacters: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_HISTORY_CHARACTERS)
    .optional()
    .describe("Soft character ceiling for this page.")
});

const getHistoryOutputSchema = z.object({
  sequence: compactSequenceSchema,
  thoughts: z.array(historyThoughtSchema),
  nextCursor: z.number().int().nullable()
});

const deleteSequenceInputSchema = z.object({
  sequenceId: sequenceIdSchema,
  confirm: z.literal(true).describe("Must be true because deletion is permanent.")
});

const deleteSequenceOutputSchema = z.object({
  sequenceId: sequenceIdSchema,
  deleted: z.boolean(),
  deletedThoughts: z.number().int()
});

type SequentialThinkingOutput = {
  sequenceId: string;
  thoughtNumber: number;
  totalThoughts: number;
  thoughtHistoryLength: number;
};

type CompactHistoryThought = {
  ordinal: number;
  thought: string;
  thoughtNumber: number;
  totalThoughts: number;
  nextThoughtNeeded: boolean;
  isRevision?: true;
  revisesThought?: number;
  branchFromThought?: number;
  branchId?: string;
  needsMoreThoughts?: true;
};

type CompactBranch = {
  branchId: string;
  parentBranchId: string;
  branchFromThought: number;
};

type CompactSequence = {
  sequenceId: string;
  title: string;
  completed: boolean;
  thoughtHistoryLength: number;
  lastThoughtNumber: number;
  totalThoughts: number;
  branches: CompactBranch[];
};

type CompactHistoryOutput = {
  sequence: CompactSequence;
  thoughts: CompactHistoryThought[];
  nextCursor: number | null;
};

function errorResult(code: string, message: string) {
  return {
    content: [{ type: "text" as const, text: `${code}: ${message}` }],
    isError: true as const
  };
}

function unexpectedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event: "mcp_tool_error", message }));
  return errorResult(
    "tool_execution_failed",
    "The tool could not complete because of an internal server error."
  );
}

function compactSequence(sequence: SequenceSummary): CompactSequence {
  return {
    sequenceId: sequence.sequenceId,
    title: sequence.title,
    completed: sequence.completed,
    thoughtHistoryLength: sequence.thoughtHistoryLength,
    lastThoughtNumber: sequence.lastThoughtNumber,
    totalThoughts: sequence.totalThoughts,
    branches: sequence.branches.map((branch) => ({
      branchId: branch.branchId,
      parentBranchId: branch.parentBranchId,
      branchFromThought: branch.branchFromThought
    }))
  };
}

function compactHistoryThought(thought: ThoughtRecord): CompactHistoryThought {
  return {
    ordinal: thought.ordinal,
    thoughtNumber: thought.thoughtNumber,
    totalThoughts: thought.totalThoughts,
    thought: thought.thought,
    nextThoughtNeeded: thought.nextThoughtNeeded,
    ...(thought.isRevision ? { isRevision: true as const } : {}),
    ...(thought.revisesThought === null ? {} : { revisesThought: thought.revisesThought }),
    ...(thought.branchFromThought === null
      ? {}
      : { branchFromThought: thought.branchFromThought }),
    ...(thought.branchId === MAIN_BRANCH_ID ? {} : { branchId: thought.branchId }),
    ...(thought.needsMoreThoughts ? { needsMoreThoughts: true as const } : {})
  };
}

function compactAppendResult(value: AppendThoughtResult): SequentialThinkingOutput {
  return {
    sequenceId: value.sequenceId,
    thoughtNumber: value.thoughtNumber,
    totalThoughts: value.totalThoughts,
    thoughtHistoryLength: value.thoughtHistoryLength
  };
}

function currentThoughtLabel(value: AppendThoughtResult): string {
  const thought = value.thought;
  const position = `${thought.thoughtNumber}/${thought.totalThoughts}`;
  const branchSuffix =
    thought.branchId === MAIN_BRANCH_ID ? "" : ` · branch ${thought.branchId}`;
  if (thought.isRevision && thought.revisesThought !== null) {
    return `Revision of thought ${thought.revisesThought}${branchSuffix} · ${position}`;
  }
  if (thought.branchId !== MAIN_BRANCH_ID) {
    const origin = thought.branchFromThought === null ? "" : ` from thought ${thought.branchFromThought}`;
    return `Branch ${thought.branchId}${origin} · ${position}`;
  }
  return `Thought ${position}`;
}

function sequentialText(value: AppendThoughtResult): string {
  const noun = value.thoughtHistoryLength === 1 ? "thought" : "thoughts";
  const notes: string[] = [];
  if (value.reopened) {
    notes.push(
      value.sequence.completed
        ? "Note: this sequence had already been completed; this thought extends it and it remains complete."
        : "Note: this sequence was previously complete and has been reopened."
    );
  }
  if (value.numberReused) {
    notes.push(
      `Note: thought number ${value.thoughtNumber} already existed on this branch; check the numbering if that was not intended.`
    );
  }
  return [
    currentThoughtLabel(value),
    ...(notes.length > 0 ? ["", ...notes] : []),
    "",
    value.thought.thought,
    "",
    `Sequence: ${value.sequenceId} · ${value.thoughtHistoryLength} ${noun} stored`
  ].join("\n");
}

function historyText(value: CompactHistoryOutput): string {
  const lines = [
    `Sequential Thinking — ${value.sequence.title}`,
    `${value.sequence.sequenceId} · ${value.sequence.thoughtHistoryLength} thoughts stored`
  ];
  if (value.sequence.branches.length > 0) {
    lines.push(
      `Branches: ${value.sequence.branches
        .map((branch) => `${branch.branchId} (from ${branch.parentBranchId} #${branch.branchFromThought})`)
        .join(", ")}`
    );
  }
  lines.push("");

  for (const thought of value.thoughts) {
    const notes: string[] = [];
    if (thought.isRevision) notes.push(`revision of #${thought.revisesThought ?? "?"}`);
    if (thought.branchId) notes.push(`branch ${thought.branchId}`);
    if (thought.branchFromThought !== undefined) notes.push(`from #${thought.branchFromThought}`);
    const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";
    lines.push(`[${thought.thoughtNumber}/${thought.totalThoughts}]${suffix}`);
    lines.push(thought.thought, "");
  }

  if (value.nextCursor !== null) lines.push(`nextCursor: ${value.nextCursor}`);
  return lines.join("\n").trimEnd();
}

const sequentialThinkingDescription = `Persist one explicit reasoning step in a durable sequence.

Use repeatedly for analysis, planning, revisions, branching, hypothesis testing, and verification. Omit sequenceId on the first call, then preserve the returned sequenceId. The sequenceId is the only key to a sequence's stored history, so keep it in the conversation. The complete current thought is returned as readable text, while structured output stays compact. Earlier thoughts remain stored and are not repeated on every call; use get_thought_history only when prior context is missing or explicitly needed.

Clients supporting MCP Apps render each thought as its own card, and the final thought's card shows the complete stored process. Other clients receive the normal text result.`;

export function createSequentialThinkingServer(env: WorkerEnv): McpServer {
  const store = getThoughtStore(env);
  const server = new McpServer(
    {
      name: "durable-thinking",
      version: SERVER_VERSION,
      title: "Sequential Thinking"
    },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
        extensions: { "io.modelcontextprotocol/ui": {} }
      } as any,
      instructions:
        "Use sequentialthinking for complex multi-step work. Omit sequenceId only for the first step, then preserve it. The sequenceId is the only key to a sequence's history, so keep it in the conversation. The current thought is returned each time; call get_thought_history only when earlier reasoning is absent from context."
    }
  );

  server.registerResource(
    "Sequential Thinking Process",
    THOUGHT_APP_URI,
    {
      title: "Sequential Thinking Process",
      description: "A unified interactive timeline for one persisted thought sequence.",
      mimeType: MCP_APP_MIME_TYPE,
      _meta: THOUGHT_APP_RESOURCE_META
    } as any,
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: MCP_APP_MIME_TYPE,
          text: thoughtProcessHtml,
          _meta: THOUGHT_APP_RESOURCE_META
        } as any
      ]
    })
  );

  server.registerTool(
    "sequentialthinking",
    {
      title: "Sequential Thinking",
      description: sequentialThinkingDescription,
      inputSchema: sequentialThinkingInputSchema,
      outputSchema: sequentialThinkingOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      _meta: THOUGHT_TOOL_META
    },
    async (args) => {
      try {
        const result = await store.appendThought({
          sequenceId: args.sequenceId ?? null,
          sequenceTitle: null,
          thought: args.thought,
          nextThoughtNeeded: args.nextThoughtNeeded,
          thoughtNumber: args.thoughtNumber,
          totalThoughts: args.totalThoughts,
          isRevision: args.isRevision ?? false,
          revisesThought: args.revisesThought ?? null,
          branchFromThought: args.branchFromThought ?? null,
          branchFromBranchId: args.branchFromBranchId ?? null,
          branchId: args.branchId ?? MAIN_BRANCH_ID,
          needsMoreThoughts: args.needsMoreThoughts ?? false,
          clientRequestId: null,
          returnHistoryLimit: 0,
          now: Date.now()
        });
        if (!result.ok) return errorResult(result.error.code, result.error.message);
        return {
          content: [{ type: "text" as const, text: sequentialText(result.value) }],
          structuredContent: compactAppendResult(result.value),
          _meta: THOUGHT_TOOL_META
        };
      } catch (error) {
        return unexpectedError(error);
      }
    }
  );

  server.registerTool(
    "get_thought_history",
    {
      title: "Get Thought History",
      description:
        "Reload persisted full-text thoughts for a sequence. Use only when earlier reasoning is missing or explicitly requested.",
      inputSchema: getHistoryInputSchema,
      outputSchema: getHistoryOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: HISTORY_TOOL_META
    },
    async (args) => {
      try {
        const result = await store.getHistory({
          sequenceId: args.sequenceId,
          limit: args.limit ?? 50,
          cursor: args.cursor ?? null,
          order: args.order ?? "asc",
          branchId: args.branchId ?? null,
          maxCharacters: args.maxCharacters ?? DEFAULT_HISTORY_CHARACTERS,
          now: Date.now()
        });
        if (!result.ok) return errorResult(result.error.code, result.error.message);
        const source: GetHistoryResult = result.value;
        const value: CompactHistoryOutput = {
          sequence: compactSequence(source.sequence),
          thoughts: source.thoughts.map(compactHistoryThought),
          nextCursor: source.nextCursor
        };
        return {
          content: [{ type: "text" as const, text: historyText(value) }],
          structuredContent: value,
          _meta: HISTORY_TOOL_META
        };
      } catch (error) {
        return unexpectedError(error);
      }
    }
  );

  // There is deliberately no list_thought_sequences tool: the unguessable
  // sequenceId is the capability that scopes a sequence to the conversation
  // that created it. A global listing would expose every session's history
  // to every connected client.
  server.registerTool(
    "delete_thought_sequence",
    {
      title: "Delete Thought Sequence",
      description: "Permanently delete one stored sequence and all of its thought text.",
      inputSchema: deleteSequenceInputSchema,
      outputSchema: deleteSequenceOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: MODEL_ONLY_META
    },
    async ({ sequenceId }) => {
      try {
        const result = await store.deleteSequence({ sequenceId, now: Date.now() });
        if (!result.ok) return errorResult(result.error.code, result.error.message);
        const value = result.value;
        return {
          content: [
            {
              type: "text" as const,
              text: value.deleted
                ? `Deleted ${value.sequenceId} and ${value.deletedThoughts} stored thought${value.deletedThoughts === 1 ? "" : "s"}.`
                : `No stored sequence existed with ID ${value.sequenceId}.`
            }
          ],
          structuredContent: value,
          _meta: MODEL_ONLY_META
        };
      } catch (error) {
        return unexpectedError(error);
      }
    }
  );

  return server;
}
