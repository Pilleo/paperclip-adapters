import { z } from "zod";
import { JulesSessionId, PaperclipId, JulesActivityId, PrUrl, asJulesSessionId, asPaperclipId, asJulesActivityId, asPrUrl } from "./brands.js";
import { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { MutationCheckpointSchema, MutationCheckpoint } from "./mutation-checkpoint.js";
import type { ProviderContinuation } from "./provider-continuation.js";

export const JULES_SESSION_STATES = [
  "QUEUED",
  "PLANNING",
  "IN_PROGRESS",
  "AWAITING_USER_FEEDBACK",
  "AWAITING_PLAN_APPROVAL",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "UNKNOWN",
] as const;

export type JulesSessionState = typeof JULES_SESSION_STATES[number];

export function normalizeJulesState(value: unknown): JulesSessionState {
  return typeof value === "string" && (JULES_SESSION_STATES as readonly string[]).includes(value)
    ? value as JulesSessionState
    : "UNKNOWN";
}

export const JulesSessionStateSchema: z.ZodType<JulesSessionState | undefined, z.ZodTypeDef, unknown> = z.preprocess(
  (value) => value === undefined ? undefined : normalizeJulesState(value),
  z.enum(JULES_SESSION_STATES).optional(),
);

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

const NativeAgentAdjudicationSchema = z.object({
  type: z.literal("agent_adjudication"),
  julesActivityId: z.string(),
  paperclipInteractionId: z.string().min(1),
  question: z.string(),
  reviewerAgentId: z.string().min(1),
  nativeForm: z.literal(true),
  transport: z.enum(["direct_parent_form", "child_form_bridge"]).optional(),
  reviewerChildIssueId: z.string().min(1).optional(),
  reviewerInteractionId: z.string().min(1).optional(),
  adjudicationGeneration: z.number().int().min(0).max(10).optional(),
  createdAt: z.string(),
});

const LegacyAgentAdjudicationSchema = z.object({
  type: z.literal("agent_adjudication"),
  julesActivityId: z.string(),
  paperclipInteractionId: z.string().optional(),
  question: z.string(),
  adjudicationIssueId: z.string().min(1),
  reviewerAgentId: z.string().min(1),
  adjudicationGeneration: z.number().int().min(0).max(10).optional(),
  createdAt: z.string(),
});

export type NativeAgentAdjudication = z.infer<typeof NativeAgentAdjudicationSchema>;
export type LegacyAgentAdjudication = z.infer<typeof LegacyAgentAdjudicationSchema>;

export function isNativeAgentAdjudication(value: unknown): value is NativeAgentAdjudication {
  return Boolean(value && typeof value === "object" &&
    (value as { type?: unknown }).type === "agent_adjudication" &&
    (value as { nativeForm?: unknown }).nativeForm === true);
}

export const PendingInteractionSchema = z.union([
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
    type: z.literal("plan_agent_review"),
    julesActivityId: z.string(),
    paperclipInteractionId: z.string().optional(),
    question: z.string(),
    planRevisionId: z.string(),
    planRevisionNumber: z.number().int().positive(),
    planDocumentId: z.string(),
    reviewIssueId: z.string().min(1),
    reviewerAgentId: z.string().min(1),
    stage: z.enum(["vibe", "strong"]),
    createdAt: z.string(),
  }),
  z.object({
    type: z.literal("plan_native_review"),
    /** v2 is the executable request_item_verdicts protocol; omitted means legacy v1. */
    protocolVersion: z.literal(2).optional(),
    julesActivityId: z.string(),
    paperclipInteractionId: z.string().min(1),
    question: z.string(),
    planRevisionId: z.string().min(1),
    planRevisionNumber: z.number().int().positive(),
    planDocumentId: z.string().min(1),
    reviewerAgentId: z.string().min(1),
    stage: z.enum(["luna", "terra"]),
    createdAt: z.string(),
  }),
  z.object({
    type: z.literal("completion_confirmation"),
    paperclipInteractionId: z.string().min(1),
    question: z.string(),
    createdAt: z.string()
  }),
  z.union([NativeAgentAdjudicationSchema, LegacyAgentAdjudicationSchema])
]);

const PlanAgentReviewSchema = z.object({
  type: z.literal("plan_agent_review"),
  julesActivityId: z.string(),
  paperclipInteractionId: z.string().optional(),
  question: z.string(),
  planRevisionId: z.string(),
  planRevisionNumber: z.number().int().positive(),
  planDocumentId: z.string(),
  reviewIssueId: z.string().min(1),
  reviewerAgentId: z.string().min(1),
  stage: z.enum(["vibe", "strong"]),
  createdAt: z.string(),
});

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
  /** Immutable GitHub head observed when Jules handed this PR to review. */
  currentPrHeadSha: z.string().min(1).optional(),
  prRegisteredOnBoard: z.boolean().optional(),
  pendingInteraction: PendingInteractionSchema.optional(),
  /** Internal plan review temporarily suspended while Jules asks a question. */
  deferredPlanReview: PlanAgentReviewSchema.optional(),
  /** Standing channel: id of the always-open "Reply to Jules" interaction. */
  standingChannelId: z.string().optional(),
  relayNextAnswerToJules: z.boolean().optional(),
  /** Set after approvePlan is relayed successfully; prevents double-approve on resume. */
  planApprovedAt: z.string().optional(),
  /** Exact Jules planGenerated activity approved by the provider. */
  planApprovedActivityId: z.string().min(1).optional(),
  planReviewRevisionId: z.string().optional(),
  /** Bounded suffix used only when restoring an adapter-withdrawn plan card. */
  planReviewRecoveryAttempt: z.number().int().min(0).max(3).optional(),
  planReviewOutcome: z.enum(["approved", "revision_requested", "human_escalation", "superseded_terminal", "superseded_provider_question", "superseded_pr_rejection"]).optional(),
  /** Exact plan activity withdrawn because a newer provider question took priority. */
  supersededPlanActivityId: z.string().min(1).optional(),
  /** Typed plan fingerprint suppressed after a reviewer rejection. */
  supersededPlanFingerprint: z.string().min(1).optional(),
  /** Provider question retained across the preemption heartbeat handoff. */
  unresolvedProviderQuestionActivityId: z.string().min(1).optional(),
  feedbackInteractionAttempt: z.number().int().min(0).optional(),
  /** Number of times an adjudication child was requeued after invalid terminal output. */
  adjudicationRecoveryCount: z.number().int().min(0).max(2).optional(),
  /** One-time migration repair for legacy child activation races that expired the typed form. */
  adjudicationBridgeRepairAttempt: z.number().int().min(0).max(1).optional(),
  /** One-time migration repair when an old native bridge lost its visible parent card. */
  missingParentBridgeRepairAttempt: z.number().int().min(0).max(1).optional(),
  deliveredFeedbackInteractionId: z.string().optional(),
  /** Jules activity ID whose reply was sent; prevents stale remote state reopening it. */
  deliveredFeedbackActivityId: z.string().optional(),
  deliveredActivityIds: z.array(z.string().min(1)).max(200).optional(),
  relayedReviewCommentIds: z.array(z.string()).optional(),
  /** Stable key for the last PR scope-drift notification sent to Jules. */
  scopeDriftFingerprint: z.string().optional(),
  /** Last native reviewer rejection delivered to the Jules provider. */
  workerFeedbackDeliveryId: z.string().optional(),
  providerContinuation: z.discriminatedUnion("state", [
    z.object({
      deliveryId: z.string().min(1),
      state: z.literal("sent_awaiting_provider"),
      sentAt: z.string().datetime(),
    }),
    z.object({
      deliveryId: z.string().min(1),
      state: z.literal("provider_acknowledged"),
      sentAt: z.string().datetime(),
      acknowledgedActivityId: z.string().min(1),
    }),
  ]).optional(),
  activityCheckpoint: z.object({
    createTime: z.string().datetime(),
    id: z.string().min(1),
  }).optional(),
  lastActivityId: z.string().optional(),
  lastWatchdogNudgeAt: z.string().optional(),
  watchdogNudgeCount: z.number().int().min(0).optional(),
  inPlaceRetryCount: z.number().int().min(0).optional(),
  mutationCheckpoint: MutationCheckpointSchema.optional(),
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

  if (session.planApprovedAt && session.pendingInteraction?.type === "plan_approval") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pendingInteraction"],
      message: "A plan approval interaction cannot remain pending after plan approval",
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
  julesState?: JulesSessionState | undefined;
  attempt: number;
  failedSessions: Array<{
    sessionId?: string | undefined;
    failedAt: string;
    message: string;
    classification: "transient" | "configuration" | "task" | "unknown";
    prUrl?: string | undefined;
  }>;
  currentPrUrl?: PrUrl | undefined;
  currentPrHeadSha?: string | undefined;
  prRegisteredOnBoard?: boolean | undefined;
  /** Monotonic key suffix used when a feedback card must be re-opened. */
  feedbackInteractionAttempt?: number | undefined;
  adjudicationRecoveryCount?: number | undefined;
  adjudicationBridgeRepairAttempt?: number | undefined;
  missingParentBridgeRepairAttempt?: number | undefined;
  deliveredFeedbackInteractionId?: string | undefined;
  deliveredFeedbackActivityId?: string | undefined;
  planApprovedAt?: string;
  /** Exact Jules planGenerated activity approved by the provider. */
  planApprovedActivityId?: string | undefined;
  planReviewRevisionId?: string | undefined;
  planReviewRecoveryAttempt?: number | undefined;
  planReviewOutcome?: "approved" | "revision_requested" | "human_escalation" | "superseded_terminal" | "superseded_provider_question" | "superseded_pr_rejection" | undefined;
  supersededPlanActivityId?: string | undefined;
  supersededPlanFingerprint?: string | undefined;
  unresolvedProviderQuestionActivityId?: string | undefined;
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
    | {
      type: "agent_adjudication";
        julesActivityId: JulesActivityId;
        paperclipInteractionId: string;
        question: string;
        reviewerAgentId: string;
        nativeForm: true;
        transport?: "direct_parent_form" | "child_form_bridge";
        reviewerChildIssueId?: string;
        reviewerInteractionId?: string;
        adjudicationGeneration?: number;
        createdAt: string;
      }
    | {
        type: "agent_adjudication";
        julesActivityId: JulesActivityId;
        paperclipInteractionId?: string | undefined;
        question: string;
        adjudicationIssueId: string;
        reviewerAgentId: string;
        adjudicationGeneration?: number;
        createdAt: string;
      }
    | {
      type: "plan_agent_review";
        julesActivityId: JulesActivityId;
        paperclipInteractionId?: string | undefined;
        question: string;
        planRevisionId: string;
        planRevisionNumber: number;
        planDocumentId: string;
        reviewIssueId: string;
        reviewerAgentId: string;
        stage: "vibe" | "strong";
      createdAt: string;
    }
    | {
        type: "plan_native_review";
        /** v2 is the executable request_item_verdicts protocol; omitted means legacy v1. */
        protocolVersion?: 2 | undefined;
        julesActivityId: JulesActivityId;
        paperclipInteractionId: string;
        question: string;
        planRevisionId: string;
        planRevisionNumber: number;
        planDocumentId: string;
        reviewerAgentId: string;
        stage: "luna" | "terra";
        createdAt: string;
      }
    | undefined;
  /** Internal plan review temporarily suspended while a provider question is adjudicated. */
  deferredPlanReview?: {
    type: "plan_agent_review";
    julesActivityId: JulesActivityId;
    paperclipInteractionId?: string | undefined;
    question: string;
    planRevisionId: string;
    planRevisionNumber: number;
    planDocumentId: string;
    reviewIssueId: string;
    reviewerAgentId: string;
    stage: "vibe" | "strong";
    createdAt: string;
  } | undefined;
  /** Recent Jules activities already mirrored to the Paperclip issue thread. */
  deliveredActivityIds?: string[] | undefined;
  relayedReviewCommentIds?: string[] | undefined;
  /** Prevents identical PR drift observations from replaying provider messages. */
  scopeDriftFingerprint?: string | undefined;
  workerFeedbackDeliveryId?: string | undefined;
  providerContinuation?: ProviderContinuation | undefined;
  /** High-water mark for the normalized Jules activity stream. */
  activityCheckpoint?: { createTime: string; id: string } | undefined;
  lastActivityId?: string | undefined;
  lastWatchdogNudgeAt?: string | undefined;
  watchdogNudgeCount?: number | undefined;
  inPlaceRetryCount?: number | undefined;
  mutationCheckpoint?: MutationCheckpoint | undefined;
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
          : undefined,
        deferredPlanReview: raw.deferredPlanReview
          ? {
              ...raw.deferredPlanReview,
              julesActivityId: asJulesActivityId(raw.deferredPlanReview.julesActivityId),
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
