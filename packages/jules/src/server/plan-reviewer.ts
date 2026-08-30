/**
 * Plan review ladder:
 *   1. static — compiler / plan verifier (no LLM)
 *   2. vibe_mistral — Mistral first (do not skip when the key exists)
 *   3. luna — only if Mistral is unavailable
 *   4. terra_codex — Codex (not xAI Grok). Grok is a separate adapter.
 *   5. human — last resort
 */

export type PlanReviewStage = "static" | "vibe_mistral" | "luna" | "terra_codex" | "human";

export type PlanReviewAction = "CONTINUE" | "AUTO_APPROVE" | "ESCALATE_TO_OPERATOR";

export interface PlanReviewContext {
  title?: string | undefined;
  description?: string | undefined;
  targetFiles?: readonly string[] | undefined;
  targetSymbols?: readonly string[] | undefined;
  testFiles?: readonly string[] | undefined;
  hostPlanMarkdown?: string | undefined;
  cheapReviewer?: PlanModelReviewer | undefined;
  /** @deprecated use cheapReviewer */
  vibeLunaReviewer?: PlanModelReviewer | undefined;
  terraCodexReviewer?: PlanModelReviewer | undefined;
  /** @deprecated use terraCodexReviewer */
  terraGrokReviewer?: PlanModelReviewer | undefined;
}

export interface PlanReviewVerdict {
  isClear: boolean;
  action: PlanReviewAction;
  stage: PlanReviewStage;
  reviewSummary: string;
  findings: string[];
  questions: string[];
}

export type PlanModelReviewer = (input: {
  planMarkdown: string;
  context: PlanReviewContext;
  prior: PlanReviewVerdict;
}) => Promise<PlanReviewVerdict> | PlanReviewVerdict;

const INVARIANT_RED_FLAGS = [
  { pattern: /catch.*EPERM/i, message: "Plan appears to catch EPERM without rethrowing (violates zero-swallow invariant)." },
  { pattern: /catch.*EACCES/i, message: "Plan appears to catch EACCES silently (violates zero-swallow invariant)." },
  { pattern: /swallow.*exception/i, message: "Plan mentions swallowing exceptions." },
  { pattern: /skip.*test/i, message: "Plan mentions skipping tests instead of fixing root causes." },
  { pattern: /ignore.*failure/i, message: "Plan mentions ignoring test or assertion failures." },
  { pattern: /silent.*bypass/i, message: "Plan mentions silent fallback or bypass mechanisms." },
];

const AMBIGUITY_PATTERNS = [
  /TBD/i,
  /TODO/i,
  /maybe/i,
  /not sure/i,
  /figure out later/i,
  /unclear/i,
  /look into.*and see/i,
];

function composeFullPlan(planMarkdown: string, hostPlanMarkdown?: string): string {
  if (!hostPlanMarkdown || hostPlanMarkdown.trim().length === 0) return planMarkdown;
  if (planMarkdown.includes(hostPlanMarkdown.trim())) return planMarkdown;
  return `${planMarkdown.trim()}\n\n### Host work-package plan (full short contract)\n\n${hostPlanMarkdown.trim()}\n`;
}

function hasInvariant(verdict: PlanReviewVerdict): boolean {
  return verdict.findings.some((f) => f.includes("🚨"));
}

function stagePassed(verdict: PlanReviewVerdict): boolean {
  return verdict.questions.length === 0 && !hasInvariant(verdict);
}

export function evaluatePlanStatically(
  planMarkdown: string,
  context: PlanReviewContext = {},
): PlanReviewVerdict {
  const text = planMarkdown.trim();
  const findings: string[] = [];
  const questions: string[] = [];

  for (const { pattern, message } of INVARIANT_RED_FLAGS) {
    if (pattern.test(text)) {
      findings.push(`🚨 [Security Invariant]: ${message}`);
    }
  }

  for (const pattern of AMBIGUITY_PATTERNS) {
    if (pattern.test(text)) {
      findings.push("⚠️ [Ambiguity]: Plan contains unresolved speculative language or TBD markers.");
      questions.push("What is the exact concrete design for the unverified parts of this plan?");
      break;
    }
  }

  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const stepLines = lines.filter((l) => /^(?:\d+\.|\*|-)\s+/.test(l.trim()));
  if (stepLines.length < 2) {
    findings.push("⚠️ [Completeness]: Plan has fewer than 2 distinct implementation steps.");
    questions.push("Can you detail the step-by-step implementation and verification sequence?");
  }

  const mentionsCodeOrFiles =
    /\b(?:\w+\.\w+|class|function|fun|interface|method|val|var)\b/i.test(text) ||
    Boolean(context.targetFiles?.some((f) => text.includes(f))) ||
    Boolean(context.targetSymbols?.some((s) => text.includes(s)));

  if (!mentionsCodeOrFiles) {
    findings.push("⚠️ [Code Boundaries]: Plan does not reference specific code files, types, or symbols.");
    questions.push("Which exact source files and classes will be modified?");
  }

  const mentionsTesting =
    /\b(?:test|tests|testing|gradlew|verify|verification|assert|reproducer|spec|coverage)\b/i.test(text);
  if (!mentionsTesting) {
    findings.push("⚠️ [Verification]: Plan lacks an explicit testing or verification phase.");
    questions.push("How will this change be verified (what unit tests or Gradle tasks will run)?");
  }

  const blocked = findings.some((f) => f.includes("🚨")) || questions.length > 0;
  return {
    isClear: !blocked,
    action: "CONTINUE",
    stage: "static",
    reviewSummary: blocked
      ? `[Static verifier] ${findings.some((f) => f.includes("🚨")) ? "Invariant failure." : `${questions.length} structural gap(s).`}`
      : "[Static verifier] Plan structure and declared scope check out.",
    findings: blocked ? findings : [
      "Step-by-step implementation sequence is concrete and well-scoped.",
      "Identifies target files and symbol boundaries cleanly.",
      "Explicit verification and automated test plan included.",
    ],
    questions,
  };
}

export function applyHostContext(
  prior: PlanReviewVerdict,
  context: PlanReviewContext = {},
): PlanReviewVerdict {
  const hostText = [
    context.hostPlanMarkdown ?? "",
    context.description ?? "",
    ...(context.targetFiles ?? []),
    ...(context.targetSymbols ?? []),
    ...(context.testFiles ?? []),
  ].join("\n");

  const remainingQuestions = prior.questions.filter((question) => !hostAnswersQuestion(question, context, hostText));
  const invariantFindings = prior.findings.filter((f) => f.includes("🚨"));
  if (invariantFindings.length > 0) {
    return {
      isClear: false,
      action: "CONTINUE",
      stage: "static",
      reviewSummary: "[Static verifier] Invariant flags remain after reading the work package.",
      findings: invariantFindings,
      questions: remainingQuestions,
    };
  }

  if (remainingQuestions.length === 0) {
    return {
      isClear: true,
      action: "CONTINUE",
      stage: "static",
      reviewSummary: "[Static verifier] Work package already answered structural gaps; not paging a human.",
      findings: [
        ...(context.targetFiles?.length ? [`Host target files: ${context.targetFiles.join(", ")}`] : prior.findings),
      ],
      questions: [],
    };
  }

  return {
    isClear: false,
    action: "CONTINUE",
    stage: "static",
    reviewSummary: `[Static verifier] ${remainingQuestions.length} gap(s) remain after reading the issue and work package.`,
    findings: prior.findings.filter((f) => f.includes("🚨") || remainingQuestions.length > 0),
    questions: remainingQuestions,
  };
}

function hostAnswersQuestion(question: string, context: PlanReviewContext, hostText: string): boolean {
  const q = question.toLowerCase();
  const hostHasFiles = (context.targetFiles?.length ?? 0) > 0 || (context.targetSymbols?.length ?? 0) > 0;
  const hostHasTests =
    (context.testFiles?.length ?? 0) > 0 || /\b(?:test|verify|gradlew|spec)\b/i.test(hostText);
  const hostIsConcrete =
    hostText.trim().length > 0 && !/(?:\bTBD\b|\bTODO\b|not sure|figure out later)/i.test(hostText);

  if (/source files|classes will be modified|files and classes/.test(q) && hostHasFiles) return true;
  if (/verified|unit tests|gradle/.test(q) && hostHasTests) return true;
  if (/unverified|step-by-step|implementation and verification/.test(q) && hostIsConcrete) return true;
  return false;
}

/** Cheap local pass. If this finds issues, Terra/Codex is not spent. */
export function defaultCheapReviewer(input: {
  planMarkdown: string;
  context: PlanReviewContext;
  prior: PlanReviewVerdict;
}): PlanReviewVerdict {
  const stage: PlanReviewStage = "luna";
  if (hasInvariant(input.prior)) {
    return {
      ...input.prior,
      action: "CONTINUE",
      stage,
      isClear: false,
      reviewSummary: "[Cheap] Static invariant flags still present; not calling Terra/Codex.",
    };
  }
  if (input.prior.questions.length > 0) {
    return {
      ...input.prior,
      action: "CONTINUE",
      stage,
      isClear: false,
      reviewSummary: "[Cheap] Gaps remain after a cheap reread; not calling Terra/Codex.",
    };
  }
  return {
    isClear: true,
    action: "CONTINUE",
    stage,
    reviewSummary: "[Cheap] No issues. Handing off to Terra/Codex.",
    findings: [],
    questions: [],
  };
}

/** @deprecated use defaultCheapReviewer */
export const defaultVibeLunaReviewer = defaultCheapReviewer;

function parseModelJson(raw: string): { approve?: boolean; findings?: string[]; questions?: string[]; summary?: string } {
  try {
    return JSON.parse(raw) as { approve?: boolean; findings?: string[]; questions?: string[]; summary?: string };
  } catch {
    return {};
  }
}

async function openAiCompatiblePlanReview(input: {
  url: string;
  apiKey: string;
  model: string;
  system: string;
  planMarkdown: string;
  context: PlanReviewContext;
  prior: PlanReviewVerdict;
  stage: PlanReviewStage;
}): Promise<PlanReviewVerdict> {
  const res = await fetch(input.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.system },
        {
          role: "user",
          content: JSON.stringify({
            title: input.context.title,
            targetFiles: input.context.targetFiles,
            targetSymbols: input.context.targetSymbols,
            testFiles: input.context.testFiles,
            hostPlanMarkdown: input.context.hostPlanMarkdown,
            planMarkdown: input.planMarkdown,
            priorSummary: input.prior.reviewSummary,
          }),
        },
      ],
    }),
  });
  if (!res.ok) {
    return {
      ...input.prior,
      action: "CONTINUE",
      stage: input.stage,
      isClear: false,
      reviewSummary: `[${input.stage}] Reviewer HTTP ${res.status}; not auto-approving.`,
    };
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const parsed = parseModelJson(data.choices?.[0]?.message?.content || "{}");
  const questions = Array.isArray(parsed.questions) ? parsed.questions.filter((q) => typeof q === "string") : [];
  const findings = Array.isArray(parsed.findings) ? parsed.findings.filter((f) => typeof f === "string") : [];
  const approve = parsed.approve === true && questions.length === 0 && !findings.some((f) => f.includes("🚨"));
  return {
    isClear: approve,
    action: approve ? (input.stage === "terra_codex" ? "AUTO_APPROVE" : "CONTINUE") : "CONTINUE",
    stage: input.stage,
    reviewSummary: parsed.summary || (approve ? `[${input.stage}] No issues.` : `[${input.stage}] Issues remain.`),
    findings,
    questions,
  };
}

const CHEAP_JSON_CONTRACT =
  "Reply JSON: {\"approve\":boolean,\"findings\":string[],\"questions\":string[],\"summary\":string}. Do not invent questions the issue or work package already answers. If you find issues, Terra/Codex must not run.";

export function createMistralReviewer(env: NodeJS.ProcessEnv = process.env): PlanModelReviewer | undefined {
  const mistralKey = env["MISTRAL_API_KEY"];
  if (!mistralKey) return undefined;
  return async ({ planMarkdown, context, prior }) =>
    openAiCompatiblePlanReview({
      url: "https://api.mistral.ai/v1/chat/completions",
      apiKey: mistralKey,
      model: env["VIBE_PLAN_MODEL"] || "mistral-small-latest",
      system: `You are Vibe (Mistral), the first cheap plan reviewer. ${CHEAP_JSON_CONTRACT}`,
      planMarkdown,
      context,
      prior,
      stage: "vibe_mistral",
    });
}

export function createLunaReviewer(env: NodeJS.ProcessEnv = process.env): PlanModelReviewer | undefined {
  const lunaUrl = env["LUNA_API_URL"];
  const lunaKey = env["LUNA_API_KEY"];
  if (!lunaUrl || !lunaKey) return undefined;
  return async ({ planMarkdown, context, prior }) =>
    openAiCompatiblePlanReview({
      url: `${lunaUrl.replace(/\/+$/, "")}/v1/chat/completions`,
      apiKey: lunaKey,
      model: env["LUNA_PLAN_MODEL"] || "luna",
      system: `You are Luna, the cheap plan reviewer used only when Mistral is unavailable. ${CHEAP_JSON_CONTRACT}`,
      planMarkdown,
      context,
      prior,
      stage: "luna",
    });
}

/**
 * Mistral first. Luna only when Mistral is not configured.
 * Missing both → caller should use defaultCheapReviewer.
 */
export function createCheapReviewer(env: NodeJS.ProcessEnv = process.env): PlanModelReviewer | undefined {
  return createMistralReviewer(env) ?? createLunaReviewer(env);
}

/** @deprecated use createCheapReviewer — Mistral remains first. */
export const createVibeLunaReviewer = createCheapReviewer;

/** Terra is Codex, not xAI Grok. Grok keys must not create this reviewer. */
export function createTerraCodexReviewer(env: NodeJS.ProcessEnv = process.env): PlanModelReviewer | undefined {
  const apiKey = env["CODEX_API_KEY"] || env["OPENAI_API_KEY"];
  if (!apiKey) return undefined;
  const model = env["TERRA_PLAN_MODEL"] || env["CODEX_PLAN_MODEL"] || "gpt-4o";
  const url = (env["CODEX_API_URL"] || "https://api.openai.com").replace(/\/+$/, "") + "/v1/chat/completions";
  return async ({ planMarkdown, context, prior }) =>
    openAiCompatiblePlanReview({
      url,
      apiKey,
      model,
      system:
        "You are Terra, the Codex architectural plan reviewer. Cheap Mistral/Luna already found no issues. Confirm or reject. Reply JSON: {\"approve\":boolean,\"findings\":string[],\"questions\":string[],\"summary\":string}. Do not invent questions the issue or work package already answers.",
      planMarkdown,
      context,
      prior,
      stage: "terra_codex",
    });
}

/** @deprecated Terra is Codex. This alias does not use xAI. */
export const createTerraGrokReviewer = createTerraCodexReviewer;

async function runCheapReview(
  fullPlan: string,
  context: PlanReviewContext,
  staticVerdict: PlanReviewVerdict,
): Promise<PlanReviewVerdict> {
  const injected = context.cheapReviewer ?? context.vibeLunaReviewer;
  if (injected) {
    const verdict = await injected({ planMarkdown: fullPlan, context, prior: staticVerdict });
    return { ...verdict, stage: verdict.stage === "static" ? "vibe_mistral" : verdict.stage };
  }

  const mistral = createMistralReviewer();
  if (mistral) {
    try {
      const verdict = await mistral({ planMarkdown: fullPlan, context, prior: staticVerdict });
      return { ...verdict, stage: "vibe_mistral" };
    } catch {
      /* Mistral configured but unavailable at runtime — try Luna */
    }
  }

  const luna = createLunaReviewer();
  if (luna) {
    try {
      const verdict = await luna({ planMarkdown: fullPlan, context, prior: staticVerdict });
      return { ...verdict, stage: "luna" };
    } catch {
      /* fall through */
    }
  }

  if (mistral) {
    return {
      ...staticVerdict,
      stage: "vibe_mistral",
      action: "CONTINUE",
      reviewSummary: "[Mistral] Cheap review failed and Luna was not available; not calling Terra/Codex.",
      isClear: false,
    };
  }

  return defaultCheapReviewer({ planMarkdown: fullPlan, context, prior: staticVerdict });
}

export async function evaluatePlanClarity(
  planMarkdown: string,
  context: PlanReviewContext = {},
): Promise<PlanReviewVerdict> {
  const fullPlan = composeFullPlan(planMarkdown, context.hostPlanMarkdown);
  const staticVerdict = applyHostContext(evaluatePlanStatically(fullPlan, context), context);

  let cheapVerdict: PlanReviewVerdict;
  try {
    cheapVerdict = await runCheapReview(fullPlan, context, staticVerdict);
  } catch {
    cheapVerdict = {
      ...staticVerdict,
      stage: "vibe_mistral",
      action: "CONTINUE",
      reviewSummary: "[Cheap] Review failed; not calling Terra/Codex.",
      isClear: false,
    };
  }

  if (!stagePassed(cheapVerdict)) {
    return {
      ...cheapVerdict,
      isClear: false,
      action: "ESCALATE_TO_OPERATOR",
      stage: "human",
      reviewSummary: hasInvariant(cheapVerdict)
        ? "[Human] Static/cheap flagged invariants. Terra/Codex was not called."
        : `[Human] Cheap review still has ${cheapVerdict.questions.length} gap(s). Terra/Codex was not called.`,
    };
  }

  const terra = context.terraCodexReviewer ?? context.terraGrokReviewer ?? createTerraCodexReviewer();
  if (!terra) {
    return {
      ...cheapVerdict,
      isClear: false,
      action: "ESCALATE_TO_OPERATOR",
      stage: "human",
      reviewSummary: "[Human] Cheap review found no issues, but Terra/Codex is not configured; operator is last resort.",
    };
  }

  let terraVerdict: PlanReviewVerdict;
  try {
    terraVerdict = await terra({ planMarkdown: fullPlan, context, prior: cheapVerdict });
    terraVerdict = { ...terraVerdict, stage: "terra_codex" };
  } catch {
    return {
      ...cheapVerdict,
      isClear: false,
      action: "ESCALATE_TO_OPERATOR",
      stage: "human",
      reviewSummary: "[Human] Terra/Codex failed; operator is last resort.",
    };
  }

  if (terraVerdict.action === "AUTO_APPROVE" && terraVerdict.isClear && stagePassed(terraVerdict)) {
    return {
      ...terraVerdict,
      action: "AUTO_APPROVE",
      stage: "terra_codex",
      reviewSummary: terraVerdict.reviewSummary || "[Terra/Codex] Plan approved.",
    };
  }

  return {
    ...terraVerdict,
    isClear: false,
    action: "ESCALATE_TO_OPERATOR",
    stage: "human",
    reviewSummary:
      terraVerdict.reviewSummary ||
      "[Human] Terra/Codex did not approve; operator is last resort.",
  };
}

export function composePlanForReview(julesPlanMarkdown: string, hostPlanMarkdown: string): string {
  return composeFullPlan(julesPlanMarkdown, hostPlanMarkdown);
}
