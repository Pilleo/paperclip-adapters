import { createHash } from "node:crypto";

export const QUESTION_CORRELATION_VERSION = "v2" as const;

export interface QuestionCorrelation {
  readonly version: typeof QUESTION_CORRELATION_VERSION;
  readonly parentIssueId: string;
  readonly companyId: string;
  readonly sessionId: string;
  readonly activityId: string;
  readonly reviewerAgentId: string;
  readonly questionFingerprint: string;
  readonly generation: number;
}

export function buildQuestionCorrelation(input: {
  parentIssueId: string;
  companyId: string;
  sessionId: string;
  activityId: string;
  reviewerAgentId: string;
  question: string;
  generation?: number;
}): QuestionCorrelation {
  return {
    version: QUESTION_CORRELATION_VERSION,
    parentIssueId: input.parentIssueId,
    companyId: input.companyId,
    sessionId: input.sessionId,
    activityId: input.activityId,
    reviewerAgentId: input.reviewerAgentId,
    questionFingerprint: createHash("sha256").update(input.question).digest("hex").slice(0, 24),
    generation: input.generation ?? 0,
  };
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function questionCorrelationMarker(identity: QuestionCorrelation): string {
  return `<!-- jules-question-adjudication:${identity.version}` +
    `|parent=${encode(identity.parentIssueId)}` +
    `|company=${encode(identity.companyId)}` +
    `|session=${encode(identity.sessionId)}` +
    `|activity=${encode(identity.activityId)}` +
    `|reviewer=${encode(identity.reviewerAgentId)}` +
    `|generation=${identity.generation}` +
    `|fingerprint=${identity.questionFingerprint} -->`;
}

export function parseQuestionCorrelation(text: string): QuestionCorrelation | null {
  const match = text.match(/<!--\s*jules-question-adjudication:([^>]*?)\s*-->/);
  if (!match) return null;
  const marker = (match[1] ?? "").trim();
  const fields = new Map<string, string>();
  for (const part of marker.split("|")) {
    const separator = part.indexOf("=");
    if (separator > 0) {
      const value = decode(part.slice(separator + 1));
      if (value !== null) fields.set(part.slice(0, separator), value);
    }
  }
  const version = marker.split("|", 1)[0];
  const parentIssueId = fields.get("parent");
  const companyId = fields.get("company");
  const sessionId = fields.get("session");
  const activityId = fields.get("activity");
  const reviewerAgentId = fields.get("reviewer");
  const questionFingerprint = fields.get("fingerprint");
  const generationText = fields.get("generation");
  const generation = generationText === undefined ? 0 : Number(generationText);
  if (version !== QUESTION_CORRELATION_VERSION || !parentIssueId || !companyId || !sessionId ||
      !activityId || !reviewerAgentId || !questionFingerprint || !Number.isInteger(generation) || generation < 0 || generation > 1) return null;
  return { version, parentIssueId, companyId, sessionId, activityId, reviewerAgentId, questionFingerprint, generation };
}

export function matchesQuestionCorrelation(
  issue: { parentId?: string | null; assigneeAgentId?: string | null; status?: string; description?: string | null },
  identity: QuestionCorrelation,
): boolean {
  if (issue.status === "cancelled" || issue.assigneeAgentId !== identity.reviewerAgentId) return false;
  const parsed = issue.description ? parseQuestionCorrelation(issue.description) : null;
  return parsed !== null && parsed.parentIssueId === identity.parentIssueId &&
    parsed.companyId === identity.companyId && parsed.sessionId === identity.sessionId &&
    parsed.activityId === identity.activityId && parsed.reviewerAgentId === identity.reviewerAgentId &&
    parsed.questionFingerprint === identity.questionFingerprint && parsed.generation === identity.generation;
}
