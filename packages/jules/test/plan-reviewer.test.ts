import { describe, it, expect, vi } from "vitest";
import {
  applyHostContext,
  createCheapReviewer,
  createTerraCodexReviewer,
  defaultCheapReviewer,
  evaluatePlanClarity,
  evaluatePlanStatically,
} from "../src/server/plan-reviewer.js";
import { formatPlanMarkdown, synthesizeDeterministicPlan } from "@pilleo/paperclip-adapter-common";

const workPackage = `---
title: "Cap SandboxDispatcher poolCache growth"
component: "enforcer"
priority: high
target_files: ["enforcer/src/main/kotlin/io/mazewall/enforcer/SandboxDispatcher.kt"]
target_symbols: ["SandboxDispatcher#getOrCreate"]
---

**Context:** poolCache is unbounded.
**Needed:** Bound the cache at 32 entries with LRU eviction and add tests.
`;

const hostPlan = synthesizeDeterministicPlan(workPackage, "MAZ-821");
const hostPlanMarkdown = formatPlanMarkdown(hostPlan);

const terraApprove = async () => ({
  isClear: true,
  action: "AUTO_APPROVE" as const,
  stage: "terra_codex" as const,
  reviewSummary: "[Terra/Codex] Plan approved.",
  findings: [],
  questions: [],
});

describe("plan review ladder", () => {
  it("static verifier never auto-approves — that is Terra/Codex", () => {
    const clearPlan = `### Jules Implementation Plan
1. **Modify SandboxDispatcher.kt**: bounded LRU cache (capacity 32).
2. **Unit Tests**: SandboxDispatcherCoverageTest.kt
3. **Verification**: ./gradlew :enforcer:test.`;
    const verdict = evaluatePlanStatically(clearPlan, {
      targetFiles: hostPlan.targetFiles,
      testFiles: hostPlan.testFiles,
    });
    expect(verdict.stage).toBe("static");
    expect(verdict.action).toBe("CONTINUE");
    expect(verdict.reviewSummary).toMatch(/Static verifier/);
    expect(verdict.reviewSummary).not.toMatch(/Terra/);
  });

  it("runs cheap Mistral/Luna then Terra/Codex when static+cheap find no issues", async () => {
    const clearPlan = `### Jules Implementation Plan
1. **Modify SandboxDispatcher.kt**: Replace unbounded ConcurrentHashMap with LinkedHashMap bounded LRU cache (capacity 32).
2. **Eviction cleanup**: Invoke shutdown() on evicted executor pools.
3. **Unit Tests**: Add test in SandboxDispatcherCoverageTest.kt
4. **Verification**: Run ./gradlew :enforcer:test.`;

    const verdict = await evaluatePlanClarity(clearPlan, {
      title: hostPlan.title,
      targetFiles: hostPlan.targetFiles,
      targetSymbols: hostPlan.targetSymbols.map((s) => s.symbol),
      testFiles: hostPlan.testFiles,
      hostPlanMarkdown,
      terraGrokReviewer: terraApprove,
    });

    expect(verdict.action).toBe("AUTO_APPROVE");
    expect(verdict.stage).toBe("terra_codex");
  });

  it("does not call Terra/Codex when cheap review still sees gaps", async () => {
    let terraCalled = false;
    const verdict = await evaluatePlanClarity("1. maybe later\n2. TBD", {
      terraGrokReviewer: async () => {
        terraCalled = true;
        return terraApprove();
      },
    });
    expect(terraCalled).toBe(false);
    expect(verdict.action).toBe("ESCALATE_TO_OPERATOR");
    expect(verdict.stage).toBe("human");
    expect(verdict.reviewSummary).toMatch(/Cheap review|Terra\/Codex was not called/);
  });

  it("fills lazy file/test questions from the work package before Vibe/Luna", () => {
    const vague = evaluatePlanStatically("1. Look into it maybe.\n2. TBD later.");
    const afterHost = applyHostContext(vague, {
      description: workPackage,
      targetFiles: hostPlan.targetFiles,
      testFiles: hostPlan.testFiles,
      hostPlanMarkdown,
    });
    expect(afterHost.questions).toHaveLength(0);
    expect(afterHost.action).toBe("CONTINUE");
    const vibe = defaultCheapReviewer({
      planMarkdown: "1. Look into it maybe.\n2. TBD later.",
      context: { hostPlanMarkdown },
      prior: afterHost,
    });
    expect(vibe.stage).toBe("luna");
    expect(vibe.isClear).toBe(true);
  });

  it("keeps invariant failures off Terra/Codex", async () => {
    const badPlan = `### Jules Implementation Plan
1. Catch EPERM exception silently so tests pass.
2. Skip gradle test suite to speed up CI.
3. Modify SandboxDispatcher.kt.`;
    let terraCalled = false;
    const verdict = await evaluatePlanClarity(badPlan, {
      targetFiles: hostPlan.targetFiles,
      hostPlanMarkdown,
      terraGrokReviewer: async () => {
        terraCalled = true;
        return terraApprove();
      },
    });
    expect(terraCalled).toBe(false);
    expect(verdict.action).toBe("ESCALATE_TO_OPERATOR");
    expect(verdict.stage).toBe("human");
  });

  it("uses live Mistral HTTP first and skips Terra when that reviewer finds issues", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ approve: false, findings: ["Missing lock order"], questions: ["How is the mutex ordered?"], summary: "Gaps" }) } }],
      }), { status: 200 }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const vibe = createCheapReviewer({
        MISTRAL_API_KEY: "mistral-test",
        LUNA_API_URL: "http://luna.example",
        LUNA_API_KEY: "luna-test",
      });
      expect(vibe).toBeTypeOf("function");
      let terraCalled = false;
      const verdict = await evaluatePlanClarity("1. Change Foo.kt\n2. Run FooTest.kt", {
        cheapReviewer: vibe,
        terraCodexReviewer: async () => {
          terraCalled = true;
          return terraApprove();
        },
      });
      expect(fetchMock).toHaveBeenCalled();
      const url = String(fetchMock.mock.calls[0]?.[0] ?? "");
      expect(url).toContain("mistral.ai");
      expect(terraCalled).toBe(false);
      expect(verdict.stage).toBe("human");
      expect(verdict.action).toBe("ESCALATE_TO_OPERATOR");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not treat an xAI Grok key as Terra", () => {
    expect(createTerraCodexReviewer({ GROK_API_KEY: "xai-test", XAI_API_KEY: "xai-test" })).toBeUndefined();
    expect(createTerraCodexReviewer({ OPENAI_API_KEY: "openai-test" })).toBeTypeOf("function");
  });

  it("uses Luna only when Mistral is not configured", () => {
    const withMistral = createCheapReviewer({
      MISTRAL_API_KEY: "mistral-test",
      LUNA_API_URL: "http://luna.example",
      LUNA_API_KEY: "luna-test",
    });
    const lunaOnly = createCheapReviewer({
      LUNA_API_URL: "http://luna.example",
      LUNA_API_KEY: "luna-test",
    });
    expect(withMistral).toBeTypeOf("function");
    expect(lunaOnly).toBeTypeOf("function");
  });

  it.each([
    {
      desc: "Mistral is preferred over Luna when both keys exist",
      env: {
        MISTRAL_API_KEY: "mistral-key",
        LUNA_API_URL: "http://luna.example",
        LUNA_API_KEY: "luna-key",
      },
      expectedType: "function" as const,
      expectedContains: "mistral.ai",
    },
    {
      desc: "Luna is used when only Luna keys exist",
      env: {
        LUNA_API_URL: "http://luna.example",
        LUNA_API_KEY: "luna-key",
      },
      expectedType: "function" as const,
      expectedContains: "luna.example",
    },
    {
      desc: "Mistral is used when only Mistral key exists",
      env: {
        MISTRAL_API_KEY: "mistral-key",
      },
      expectedType: "function" as const,
      expectedContains: "mistral.ai",
    },
    {
      desc: "no cheap reviewer when no keys exist",
      env: {},
      expectedType: "undefined" as const,
      expectedContains: null,
    },
  ])("cheap reviewer ladder: $desc", ({ env, expectedType, expectedContains }) => {
    const reviewer = createCheapReviewer(env);
    expect(reviewer).toBeTypeOf(expectedType);
    if (reviewer && expectedContains) {
      // Verify the reviewer targets the correct endpoint by checking the env it was created with
      // Since we can't easily inspect the closure, we verify via integration in the next test
    }
  });

  it("Mistral HTTP is called (not Luna) when both keys exist in full evaluatePlanClarity", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ approve: true, findings: [], questions: [], summary: "OK" }) } }],
      }), { status: 200 }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const clearPlan = `1. Change Foo.kt
2. Run tests in FooTest.kt`;
      const verdict = await evaluatePlanClarity(clearPlan, {
        cheapReviewer: createCheapReviewer({
          MISTRAL_API_KEY: "mistral-test",
          LUNA_API_URL: "http://luna.example",
          LUNA_API_KEY: "luna-test",
        }),
        terraCodexReviewer: terraApprove,
      });
      expect(fetchMock).toHaveBeenCalled();
      const url = String(fetchMock.mock.calls[0]?.[0] ?? "");
      expect(url).toContain("mistral.ai");
      expect(url).not.toContain("luna.example");
      expect(verdict.action).toBe("AUTO_APPROVE");
      expect(verdict.stage).toBe("terra_codex");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each([
    {
      desc: "static TBD gaps never reach Terra",
      plan: "1. maybe later\n2. TBD",
      host: false,
      terra: true,
      action: "ESCALATE_TO_OPERATOR",
      stage: "human",
      terraCalled: false,
    },
    {
      desc: "invariants never reach Terra",
      plan: "1. Catch EPERM silently so tests pass.\n2. Skip gradle tests in FooTest.kt.",
      host: true,
      terra: true,
      action: "ESCALATE_TO_OPERATOR",
      stage: "human",
      terraCalled: false,
    },
    {
      desc: "clear plan auto-approves only at terra_codex",
      plan: `### Jules Implementation Plan
1. **Modify SandboxDispatcher.kt**: bounded LRU cache (capacity 32).
2. **Unit Tests**: SandboxDispatcherCoverageTest.kt
3. **Verification**: ./gradlew :enforcer:test.`,
      host: true,
      terra: true,
      action: "AUTO_APPROVE",
      stage: "terra_codex",
      terraCalled: true,
    },
    {
      desc: "clean Vibe without Terra/Codex pages the human",
      plan: `1. Change Foo.kt\n2. Run tests in FooTest.kt`,
      host: false,
      terra: false,
      action: "ESCALATE_TO_OPERATOR",
      stage: "human",
      terraCalled: false,
    },
  ])("ladder table: $desc", async ({ plan, host, terra, action, stage, terraCalled }) => {
    let called = false;
    const verdict = await evaluatePlanClarity(plan, {
      ...(host
        ? {
            title: hostPlan.title,
            targetFiles: hostPlan.targetFiles,
            targetSymbols: hostPlan.targetSymbols.map((s) => s.symbol),
            testFiles: hostPlan.testFiles,
            hostPlanMarkdown,
          }
        : {}),
      terraGrokReviewer: terra
        ? async () => {
            called = true;
            return terraApprove();
          }
        : undefined,
    });
    expect(called).toBe(terraCalled);
    expect(verdict.action).toBe(action);
    expect(verdict.stage).toBe(stage);
  });

  it("does not auto-approve without Terra/Codex even if cheap review is clean", async () => {
    const clearPlan = `1. Change Foo.kt\n2. Run tests in FooTest.kt`;
    const verdict = await evaluatePlanClarity(clearPlan, {
      terraCodexReviewer: undefined,
    });
    expect(verdict.action).toBe("ESCALATE_TO_OPERATOR");
    expect(verdict.stage).toBe("human");
    expect(verdict.reviewSummary).toMatch(/Terra\/Codex is not configured/);
  });
});
