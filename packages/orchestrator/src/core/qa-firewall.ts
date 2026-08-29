/**
 * Autonomous Q&A Clarification Firewall.
 * Intercepts questions from junior/cloud workers (like Jules), evaluates them against
 * task specifications, AST symbols, and AGENTS.md invariants using a strong model (Grok, Gemini, GPT-4o, Claude),
 * and automatically responds if confidence is high, or escalates to human operator if ambiguous.
 */

export interface ClarificationContext {
  readonly issueIdentifier: string;
  readonly issueTitle: string;
  readonly issueDescription: string;
  readonly targetFiles?: readonly string[];
  readonly targetSymbols?: readonly string[];
  readonly projectInvariants?: string;
}

export interface ClarificationResponse {
  readonly canAnswer: boolean;
  readonly confidence: "HIGH" | "MEDIUM" | "LOW";
  readonly answer: string;
  readonly reasoning: string;
  readonly requiresHumanEscalation: boolean;
  readonly escalationRationale?: string | null;
  readonly modelUsed: string;
}

export interface QaFirewallConfig {
  readonly provider?: "gemini" | "grok" | "openai" | "anthropic" | "mock" | undefined;
  readonly apiKey?: string | undefined;
  readonly modelName?: string | undefined;
  readonly autoApproveHighConfidence?: boolean | undefined;
}

export function buildClarificationPrompt(
  question: string,
  context: ClarificationContext
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `You are the Principal Systems & Security Architect for this codebase.
Your job is to act as a rigorous Clarification Firewall for autonomous developer agents.
Developer agents sometimes ask questions that are already answered in the task specification, codebase context, or architecture invariants.

RULES:
1. If the answer is clearly specified or can be logically deduced with 100% certainty from the task specification, target files, symbols, or engineering invariants:
   - Set canAnswer = true
   - Set confidence = "HIGH"
   - Set requiresHumanEscalation = false
   - Provide a clear, direct, and actionable answer for the developer agent.
2. If the question asks about an unspecified business preference, architectural ambiguity, breaking API change, or true trade-off that is NOT present in the spec:
   - Set canAnswer = false
   - Set confidence = "LOW" or "MEDIUM"
   - Set requiresHumanEscalation = true
   - Set escalationRationale explaining exactly why human decision is necessary.
3. You MUST respond with ONLY a valid JSON object matching this schema:
{
  "canAnswer": boolean,
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "answer": "string",
  "reasoning": "string",
  "requiresHumanEscalation": boolean,
  "escalationRationale": "string or null"
}`;

  const userPrompt = `### TASK CONTEXT
- **Issue**: [${context.issueIdentifier}] ${context.issueTitle}
- **Target Files**: ${context.targetFiles?.join(", ") || "None specified"}
- **Target Symbols**: ${context.targetSymbols?.join(", ") || "None specified"}

### TASK SPECIFICATION:
${context.issueDescription}

### ENGINEERING INVARIANTS & POLICIES:
${context.projectInvariants || "Standard kernel-safety, no silent fallback, strict FFM layout alignment."}

---
### ❓ QUESTION ASKED BY DEVELOPER AGENT:
"${question}"

Analyze the question against the spec and invariants, and return your JSON evaluation.`;

  return { systemPrompt, userPrompt };
}

/**
 * Parses and validates the strong model JSON response safely.
 */
export function parseModelEvaluation(rawText: string, modelName: string): ClarificationResponse {
  try {
    let clean = rawText.trim();
    // Strip markdown code block wrappers if present
    if (clean.startsWith("```json")) {
      clean = clean.slice(7);
    } else if (clean.startsWith("```")) {
      clean = clean.slice(3);
    }
    if (clean.endsWith("```")) {
      clean = clean.slice(0, -3);
    }
    clean = clean.trim();

    const parsed = JSON.parse(clean) as Record<string, unknown>;

    const canAnswer = Boolean(parsed["canAnswer"]);
    const confidence =
      parsed["confidence"] === "HIGH" || parsed["confidence"] === "MEDIUM" || parsed["confidence"] === "LOW"
        ? (parsed["confidence"] as "HIGH" | "MEDIUM" | "LOW")
        : "LOW";
    const answer = typeof parsed["answer"] === "string" ? parsed["answer"] : "";
    const reasoning = typeof parsed["reasoning"] === "string" ? parsed["reasoning"] : "";
    const requiresHumanEscalation = Boolean(parsed["requiresHumanEscalation"]) || confidence !== "HIGH";
    const escalationRationale =
      typeof parsed["escalationRationale"] === "string" ? parsed["escalationRationale"] : null;

    return Object.freeze({
      canAnswer,
      confidence,
      answer,
      reasoning,
      requiresHumanEscalation,
      escalationRationale,
      modelUsed: modelName,
    });
  } catch (err) {
    return Object.freeze({
      canAnswer: false,
      confidence: "LOW",
      answer: "",
      reasoning: `Failed to parse model response: ${err instanceof Error ? err.message : String(err)}`,
      requiresHumanEscalation: true,
      escalationRationale: "Evaluation response was malformed; escalating to operator.",
      modelUsed: modelName,
    });
  }
}

/**
 * Evaluates a question against a strong model (Grok, Gemini, OpenAI, Claude).
 */
export async function evaluateQuestionWithStrongModel(
  question: string,
  context: ClarificationContext,
  config: QaFirewallConfig = {}
): Promise<ClarificationResponse> {
  const provider = config.provider || "grok";
  const env = process.env;
  const apiKey =
    config.apiKey ||
    env["GROK_API_KEY"] ||
    env["XAI_API_KEY"] ||
    env["OPENAI_API_KEY"] ||
    env["GEMINI_API_KEY"] ||
    env["JULES_API_KEY"];

  if (provider === "mock" || !apiKey) {
    // Heuristic spec matcher fallback when offline
    const desc = context.issueDescription.toLowerCase();
    const q = question.toLowerCase();

    if (desc.includes(q) || (context.targetFiles && context.targetFiles.some((f) => q.includes(f.toLowerCase())))) {
      return Object.freeze({
        canAnswer: true,
        confidence: "HIGH",
        answer: `As specified in the task description for [${context.issueIdentifier}], please follow the declared target files (${context.targetFiles?.join(", ") || "spec"}) and standard project conventions.`,
        reasoning: "Answer directly referenced in declared target files or description.",
        requiresHumanEscalation: false,
        escalationRationale: null,
        modelUsed: "offline-spec-matcher",
      });
    }

    return Object.freeze({
      canAnswer: false,
      confidence: "LOW",
      answer: "",
      reasoning: "No external strong model API key configured; escalating to operator.",
      requiresHumanEscalation: true,
      escalationRationale: "Requires human operator clarification.",
      modelUsed: "offline-fallback",
    });
  }

  const { systemPrompt, userPrompt } = buildClarificationPrompt(question, context);

  // 1. xAI Grok / OpenAI API
  if (provider === "grok" || provider === "openai") {
    const endpoint =
      provider === "grok" ? "https://api.x.ai/v1/chat/completions" : "https://api.openai.com/v1/chat/completions";
    const model = config.modelName || (provider === "grok" ? "grok-beta" : "gpt-4o");

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      throw new Error(`QA Firewall HTTP error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content || "";
    return parseModelEvaluation(content, model);
  }

  // 2. Google Gemini API
  if (provider === "gemini") {
    const model = config.modelName || "gemini-1.5-pro";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`QA Firewall Gemini error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return parseModelEvaluation(content, model);
  }

  // 3. Anthropic Claude API
  if (provider === "anthropic") {
    const model = config.modelName || "claude-3-5-sonnet-20241022";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!res.ok) {
      throw new Error(`QA Firewall Claude error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const content = data.content?.[0]?.text || "";
    return parseModelEvaluation(content, model);
  }

  throw new Error(`Unsupported QA Firewall provider: ${String(provider)}`);
}
