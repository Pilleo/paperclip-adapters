import { describe, it, expect, vi } from "vitest";
import {
  buildClarificationPrompt,
  parseModelEvaluation,
  evaluateQuestionWithStrongModel,
  ClarificationContext,
} from "../src/core/qa-firewall.js";

describe("QA Clarification Firewall", () => {
  const mockContext: ClarificationContext = {
    issueIdentifier: "MAZ-100",
    issueTitle: "Implement Seccomp Deny Filter",
    issueDescription: "We must use SECCOMP_RET_ERRNO with EPERM. Do not use silent fallback.",
    targetFiles: ["enforcer/src/BpfFilter.kt"],
    targetSymbols: ["BpfFilter.build"],
    projectInvariants: "No silent fallback; fail-closed by default.",
  };

  it("builds a structured prompt containing task context, target symbols, and invariants", () => {
    const { systemPrompt, userPrompt } = buildClarificationPrompt(
      "Should I return EPERM or EACCES?",
      mockContext
    );

    expect(systemPrompt).toContain("Clarification Firewall");
    expect(systemPrompt).toContain("canAnswer");
    expect(userPrompt).toContain("MAZ-100");
    expect(userPrompt).toContain("enforcer/src/BpfFilter.kt");
    expect(userPrompt).toContain("BpfFilter.build");
    expect(userPrompt).toContain("Should I return EPERM or EACCES?");
  });

  it("parses high-confidence strong model response correctly", () => {
    const rawJson = JSON.stringify({
      canAnswer: true,
      confidence: "HIGH",
      answer: "Use SECCOMP_RET_ERRNO with EPERM as specified in the issue description.",
      reasoning: "Explicitly defined in the issue description.",
      requiresHumanEscalation: false,
      escalationRationale: null,
    });

    const parsed = parseModelEvaluation(rawJson, "grok-beta");
    expect(parsed.canAnswer).toBe(true);
    expect(parsed.confidence).toBe("HIGH");
    expect(parsed.requiresHumanEscalation).toBe(false);
    expect(parsed.answer).toContain("SECCOMP_RET_ERRNO with EPERM");
    expect(parsed.modelUsed).toBe("grok-beta");
  });

  it("parses low-confidence response and triggers human escalation", () => {
    const rawJson = JSON.stringify({
      canAnswer: false,
      confidence: "LOW",
      answer: "",
      reasoning: "User did not specify whether to use IPv4 or IPv6 binding for the broker.",
      requiresHumanEscalation: true,
      escalationRationale: "Architectural networking ambiguity.",
    });

    const parsed = parseModelEvaluation(rawJson, "grok-beta");
    expect(parsed.canAnswer).toBe(false);
    expect(parsed.confidence).toBe("LOW");
    expect(parsed.requiresHumanEscalation).toBe(true);
    expect(parsed.escalationRationale).toContain("Architectural networking ambiguity");
  });

  it("safely handles markdown code blocks around JSON response", () => {
    const rawWrapped = `\`\`\`json
{
  "canAnswer": true,
  "confidence": "HIGH",
  "answer": "Target file is enforcer/src/BpfFilter.kt",
  "reasoning": "In targetFiles list.",
  "requiresHumanEscalation": false,
  "escalationRationale": null
}
\`\`\``;

    const parsed = parseModelEvaluation(rawWrapped, "gemini-1.5-pro");
    expect(parsed.canAnswer).toBe(true);
    expect(parsed.confidence).toBe("HIGH");
    expect(parsed.answer).toContain("enforcer/src/BpfFilter.kt");
  });

  it("evaluates trivial questions with offline spec matcher when no external key is provided", async () => {
    const res = await evaluateQuestionWithStrongModel(
      "Is enforcer/src/BpfFilter.kt the target file?",
      mockContext,
      { provider: "mock" }
    );

    expect(res.canAnswer).toBe(true);
    expect(res.confidence).toBe("HIGH");
    expect(res.requiresHumanEscalation).toBe(false);
    expect(res.modelUsed).toBe("offline-spec-matcher");
  });

  it("escalates unknown offline questions to human operator", async () => {
    const res = await evaluateQuestionWithStrongModel(
      "Should we migrate database to PostgreSQL or CockroachDB?",
      mockContext,
      { provider: "mock" }
    );

    expect(res.canAnswer).toBe(false);
    expect(res.requiresHumanEscalation).toBe(true);
    expect(res.modelUsed).toBe("offline-fallback");
  });
});
