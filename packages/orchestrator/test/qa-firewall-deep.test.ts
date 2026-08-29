import { describe, it, expect, vi, afterEach } from "vitest";
import {
  evaluateQuestionWithStrongModel,
  buildClarificationPrompt,
  parseModelEvaluation,
} from "../src/core/qa-firewall.js";

describe("QA Firewall Deep Provider Tests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles markdown code fences when parsing evaluation response", () => {
    const rawWithFences = `\`\`\`json
{
  "canAnswer": true,
  "confidence": "HIGH",
  "answer": "Use PureJavaBpfEngine.",
  "reasoning": "Explicitly defined in AGENTS.md.",
  "requiresHumanEscalation": false,
  "escalationRationale": null
}
\`\`\``;

    const parsed = parseModelEvaluation(rawWithFences, "grok-beta");
    expect(parsed.canAnswer).toBe(true);
    expect(parsed.confidence).toBe("HIGH");
    expect(parsed.answer).toBe("Use PureJavaBpfEngine.");
  });

  it("formats evaluation prompt with task context and issue metadata", () => {
    const { systemPrompt, userPrompt } = buildClarificationPrompt(
      "Which layout should I use for seccomp_data?",
      {
        issueIdentifier: "MAZ-100",
        issueTitle: "Implement FFM layouts",
        issueDescription: "Strict 64-bit alignment required for args.",
        targetFiles: ["enforcer/src/LinuxNative.kt"],
        targetSymbols: ["LinuxNative#seccomp"],
        projectInvariants: "Zero silent bypasses",
      }
    );

    expect(systemPrompt).toContain("Principal Systems & Security Architect");
    expect(userPrompt).toContain("MAZ-100");
    expect(userPrompt).toContain("Which layout should I use");
    expect(userPrompt).toContain("Strict 64-bit alignment");
  });

  it("falls back gracefully when strong model API returns error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    }));

    await expect(
      evaluateQuestionWithStrongModel(
        "Is ABI V5 supported?",
        {
          issueIdentifier: "MAZ-100",
          issueTitle: "Landlock V5",
          issueDescription: "Verify ABI V5 availability",
        },
        { provider: "grok", apiKey: "test-key" }
      )
    ).rejects.toThrow("QA Firewall HTTP error 500");
  });
});
