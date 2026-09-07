import { z } from "zod";

export const DecisionTransportSchema = z.enum(["mcp_tool", "acp_tool", "adapter_callback"]);
export type DecisionTransport = z.infer<typeof DecisionTransportSchema>;

export const DecisionKindSchema = z.enum(["plan_review", "pull_request_review", "provider_question"]);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

export const StructuredDecisionCapabilitySchema = z.object({
  version: z.literal(1),
  transports: z.array(DecisionTransportSchema).min(1).transform((values) => [...new Set(values)]),
  decisionKinds: z.array(DecisionKindSchema).min(1).transform((values) => [...new Set(values)]),
}).strict();
export type StructuredDecisionCapability = z.infer<typeof StructuredDecisionCapabilitySchema>;

const NonEmptyTextSchema = z.string().trim().min(1);

export const StructuredDecisionSchema = z.union([
  z.object({ kind: z.literal("review"), verdict: z.literal("approve"), reason: NonEmptyTextSchema.optional() }).strict(),
  z.object({ kind: z.literal("review"), verdict: z.literal("reject"), reason: NonEmptyTextSchema }).strict(),
  z.object({ kind: z.literal("review"), verdict: z.literal("uncertain"), reason: NonEmptyTextSchema }).strict(),
  z.object({ kind: z.literal("question"), verdict: z.literal("answer"), answer: NonEmptyTextSchema }).strict(),
  z.object({ kind: z.literal("question"), verdict: z.literal("not_a_question"), reason: NonEmptyTextSchema.optional() }).strict(),
  z.object({ kind: z.literal("question"), verdict: z.literal("uncertain"), reason: NonEmptyTextSchema }).strict(),
]);
export type StructuredDecision = z.infer<typeof StructuredDecisionSchema>;
export type StructuredReviewDecision = Extract<StructuredDecision, { readonly kind: "review" }>;

export function parseStructuredDecisionCapability(value: unknown): StructuredDecisionCapability {
  return StructuredDecisionCapabilitySchema.parse(value);
}

export function validateStructuredDecision(value: unknown): StructuredDecision | null {
  const parsed = StructuredDecisionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type DecisionTransportSelection =
  | { readonly status: "supported"; readonly transport: DecisionTransport }
  | { readonly status: "unsupported"; readonly reason: "decision_kind_not_supported" | "transport_not_available" };

/** Negotiates only declared capabilities; adapter/provider names are intentionally absent. */
export function selectDecisionTransport(
  capability: StructuredDecisionCapability,
  decisionKind: DecisionKind,
  preference: readonly DecisionTransport[],
): DecisionTransportSelection {
  if (!capability.decisionKinds.includes(decisionKind)) {
    return { status: "unsupported", reason: "decision_kind_not_supported" };
  }
  const supported = new Set(capability.transports);
  const transport = preference.find((candidate) => supported.has(candidate));
  return transport
    ? { status: "supported", transport }
    : { status: "unsupported", reason: "transport_not_available" };
}
