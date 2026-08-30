import { z } from "zod";
import { JulesSessionId, PaperclipId, JulesActivityId, PrUrl, asJulesSessionId, asPaperclipId, asJulesActivityId, asPrUrl } from "./brands.js";
import { AdapterExecutionResult } from "@paperclipai/adapter-utils";

export const JulesSessionStateSchema = z.string();
export type JulesSessionState = z.infer<typeof JulesSessionStateSchema>;

export type SessionPhase = z.infer<typeof SessionPhaseSchema>;
export const SessionPhaseSchema = z.enum([
  "STARTING",
  "RUNNING",
  "WAITING_FOR_FEEDBACK",
  "WAITING_FOR_PLAN_APPROVAL",
  "RETRY_SCHEDULED",
  "PR_CREATED",
  "COMPLETED",
  "FAILED"
]);

export const FailedSessionSchema = z.object({
  sessionId: z.string().optional(),
  failedAt: z.string(),
  message: z.string(),
  classification: z.enum(["transient", "configuration", "task", "unknown"]),
  /** PR URL if the failed session had created one before failing. */
  prUrl: z.string().optional()
});

export const PendingInteractionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user_feedback"),
    julesActivityId: z.string(),
    paperclipInteractionId: z.string().optional(),
    question: z.string(),
    createdAt: z.string()
  }),
  z.object({
    type: z.literal("plan_approval"),
    julesActivityId: z.string(),
    paperclipInteractionId: z.string().optional(),
    question: z.string(),
    planDocumentId: z.string().min(1),
    planRevisionId: z.string().min(1),
    planRevisionNumber: z.number().int().positive(),
    createdAt: z.string()
  }),
  z.object({
    type: z.literal("completion_confirmation"),
    paperclipInteractionId: z.string().min(1),
    question: z.string(),
    createdAt: z.string()
  })
]);

export const JulesAdapterSessionV1Schema = z.object({
  version: z.literal(1),
  paperclipIssueId: z.string(),
  promptHash: z.string(),
  promptHashVersion: z.number().int().positive().optional(),
  repository: z.string(),
  source: z.string(),
  baseBranch: z.string(),
  phase: SessionPhaseSchema,
  // Paperclip's canonical provider session identity. For an active Jules
  // session it is deliberately duplicated by the provider-specific field.
  sessionId: z.string().min(1).optional(),
  julesSessionId: z.string().optional(),
  julesSessionUrl: z.string().optional(),
  julesState: JulesSessionStateSchema.optional(),
  attempt: z.number().int().min(1),
  failedSessions: z.array(FailedSessionSchema),
  currentPrUrl: z.string().optional(),
  prRegisteredOnBoard: z.boolean().optional(),
  pendingInteraction: PendingInteractionSchema.optional(),
  /** Standing channel: id of the always-open "Reply to Jules" interaction. */
  standingChannelId: z.string().optional(),
  relayNextAnswerToJules: z.boolean().optional(),
  /** Set after approvePlan is relayed successfully; prevents double-approve on resume. */
  planApprovedAt: z.string().optional(),
  feedbackInteractionAttempt: z.number().int().min(0).optional(),
  deliveredFeedbackInteractionId: z.string().optional(),
  deliveredActivityIds: z.array(z.string().min(1)).max(200).optional(),
  relayedReviewCommentIds: z.array(z.string()).optional(),
  activityCheckpoint: z.object({
    createTime: z.string().datetime(),
    id: z.string().min(1),
  }).optional(),
  lastActivityId: z.string().optional(),
  lastWatchdogNudgeAt: z.string().optional(),
  watchdogNudgeCount: z.number().int().min(0).optional(),
  inPlaceRetryCount: z.number().int().min(0).optional(),
  createdAt: z.string(),
  lastPolledAt: z.string().optional()
}).superRefine((session, ctx) => {
  const hasSessionId = session.sessionId !== undefined;
  const hasJulesSessionId = session.julesSessionId !== undefined;

  if (session.phase === "RETRY_SCHEDULED") {
    if (hasSessionId !== hasJulesSessionId ||
        (hasSessionId && session.sessionId !== session.julesSessionId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sessionId"],
        message: "sessionId and julesSessionId must be provided together and be equal"
      });
    }
    return;
  }

  if (!hasSessionId || !hasJulesSessionId || session.sessionId !== session.julesSessionId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sessionId"],
      message: "Active Jules sessions require equal sessionId and julesSessionId"
    });
  }
});

export interface JulesAdapterSessionV1 {
  version: 1;
  paperclipIssueId: PaperclipId;
  promptHash: string;
  promptHashVersion?: number | undefined;
  repository: string;
  source: string;
  baseBranch: string;
  phase: z.infer<typeof SessionPhaseSchema>;
  /** Paperclip canonical session identity; equal to julesSessionId when present. */
  sessionId?: string | undefined;
  julesSessionId?: JulesSessionId | undefined;
  julesSessionUrl?: string | undefined;
  julesState?: string | undefined;
  attempt: number;
  failedSessions: Array<{
    sessionId?: string | undefined;
    failedAt: string;
    message: string;
    classification: "transient" | "configuration" | "task" | "unknown";
    prUrl?: string | undefined;
  }>;
  currentPrUrl?: PrUrl | undefined;
  prRegisteredOnBoard?: boolean | undefined;
  /** Monotonic key suffix used when a feedback card must be re-opened. */
  feedbackInteractionAttempt?: number | undefined;
  deliveredFeedbackInteractionId?: string | undefined;
  planApprovedAt?: string;
  standingChannelId?: string | undefined;
  relayNextAnswerToJules?: boolean | undefined;
  pendingInteraction?:
    | {
        type: "user_feedback";
        julesActivityId: JulesActivityId;
        paperclipInteractionId?: string | undefined;
        question: string;
        createdAt: string;
      }
    | {
        type: "plan_approval";
        julesActivityId: JulesActivityId;
        paperclipInteractionId?: string | undefined;
        question: string;
        planDocumentId: string;
        planRevisionId: string;
        planRevisionNumber: number;
        createdAt: string;
      }
    | {
        type: "completion_confirmation";
        paperclipInteractionId: string;
        question: string;
        createdAt: string;
      }
    | undefined;
  /** Recent Jules activities already mirrored to the Paperclip issue thread. */
  deliveredActivityIds?: string[] | undefined;
  relayedReviewCommentIds?: string[] | undefined;
  /** High-water mark for the normalized Jules activity stream. */
  activityCheckpoint?: { createTime: string; id: string } | undefined;
  lastActivityId?: string | undefined;
  lastWatchdogNudgeAt?: string | undefined;
  watchdogNudgeCount?: number | undefined;
  inPlaceRetryCount?: number | undefined;
  createdAt: string;
  lastPolledAt?: string | undefined;
}

export type SerializedSessionParams = NonNullable<AdapterExecutionResult["sessionParams"]>;

function isEmptyRecord(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function readNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Cursor-cloud-style durable identity. Paperclip may persist only
 * sessionId, julesSessionId, agentId, or a nested display id.
 */
export function readDurableJulesSessionId(data: unknown): string | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  return (
    readNonEmpty(record["julesSessionId"]) ??
    readNonEmpty(record["sessionId"]) ??
    readNonEmpty(record["agentId"]) ??
    readNonEmpty(record["sessionDisplayId"])
  );
}

export function readLastActivityId(data: unknown): string | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const checkpoint = record["activityCheckpoint"];
  const checkpointId =
    checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint)
      ? readNonEmpty((checkpoint as Record<string, unknown>)["id"])
      : null;
  return (
    readNonEmpty(record["lastActivityId"]) ??
    readNonEmpty(record["latestRunId"]) ??
    checkpointId
  );
}

function parseCanonicalSessionParams(data: unknown): Record<string, string> | null {
  const sessionId = readDurableJulesSessionId(data);
  if (!sessionId) return null;
  const lastActivityId = readLastActivityId(data);
  return {
    sessionId,
    julesSessionId: sessionId,
    ...(lastActivityId ? { lastActivityId } : {}),
  };
}

function parseSessionRecord(data: unknown): JulesAdapterSessionV1 | null {
  if (data == null || isEmptyRecord(data)) return null;

  try {
    return JulesAdapterSessionV1Schema.parse(data) as JulesAdapterSessionV1;
  } catch {
    return null;
  }
}

export const sessionCodec = {
  deserialize(data: unknown): Record<string, unknown> | null {
      return (parseSessionRecord(data) ?? parseCanonicalSessionParams(data)) as Record<string, unknown> | null;
  },
  serialize(session: Record<string, unknown> | null): Record<string, unknown> | null {
      if (session == null) return null;
      try {
          return JulesAdapterSessionV1Schema.parse(session) as Record<string, unknown>;
      } catch {
          return parseCanonicalSessionParams(session);
      }
  },
  decode(data: unknown): JulesAdapterSessionV1 | null {
    const raw = parseSessionRecord(data);
    if (!raw) return null;

    return {
        ...raw,
        paperclipIssueId: asPaperclipId(raw.paperclipIssueId),
        julesSessionId: raw.julesSessionId ? asJulesSessionId(raw.julesSessionId) : undefined,
        currentPrUrl: raw.currentPrUrl ? asPrUrl(raw.currentPrUrl) : undefined,
        pendingInteraction: raw.pendingInteraction
          ? raw.pendingInteraction.type === "completion_confirmation"
            ? raw.pendingInteraction
            : {
                ...raw.pendingInteraction,
                julesActivityId: asJulesActivityId(raw.pendingInteraction.julesActivityId)
              }
          : undefined
    } as JulesAdapterSessionV1;
  },

  encode(session: JulesAdapterSessionV1): unknown {
    return JulesAdapterSessionV1Schema.parse(session);
  },

  getDisplayId(session: Record<string, unknown> | null): string | null {
    return readDurableJulesSessionId(session);
  },

  getCanonicalSessionId(session: unknown): string | null {
    return readDurableJulesSessionId(session);
  }
};
export function serializeSession(session: JulesAdapterSessionV1): SerializedSessionParams {
  return sessionCodec.encode(session) as SerializedSessionParams;
}
