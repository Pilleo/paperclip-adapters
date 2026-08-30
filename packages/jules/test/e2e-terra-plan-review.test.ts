import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/execute.js";
import { JulesClient } from "../src/server/jules-client.js";
import { sessionCodec } from "../src/server/session.js";
import { createJulesPlanApprovalInteraction } from "../src/server/paperclip-client.js";
import { createCheapReviewer, createTerraCodexReviewer } from "../src/server/plan-reviewer.js";

vi.mock("../src/server/jules-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/jules-client.js")>();
  const MockedJulesClient = vi.fn();
  MockedJulesClient.prototype.getSession = vi.fn();
  MockedJulesClient.prototype.getActivities = vi.fn();
  MockedJulesClient.prototype.sendMessage = vi.fn();
  MockedJulesClient.prototype.approvePlan = vi.fn();
  return { ...mod, JulesClient: MockedJulesClient };
});

vi.mock("../src/server/plan-reviewer", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/plan-reviewer.js")>();
  return {
    ...mod,
    createTerraCodexReviewer: vi.fn(() => undefined),
    createCheapReviewer: vi.fn(() => undefined),
  };
});

vi.mock("../src/server/paperclip-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/paperclip-client.js")>();
  return {
    ...mod,
    createJulesPlanApprovalInteraction: vi.fn().mockResolvedValue({
      id: "inter-plan-1",
      planRevision: { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
    }),
    createIssueComment: vi.fn().mockResolvedValue(undefined),
    getPaperclipInteraction: vi.fn(),
    moveIssueToBlocked: vi.fn(),
    moveIssueToInProgress: vi.fn(),
    listPaperclipInteractions: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("@pilleo/paperclip-adapter-common", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@pilleo/paperclip-adapter-common")>();
  return {
    ...mod,
    buildHostImplementationPlan: (raw: string, issueId: string, workspacePath?: string) => {
      const built = mod.buildHostImplementationPlan(raw, issueId, workspacePath);
      if (built.plan.targetSymbols.length === 0) return built;
      const outline = `### Codanna symbol outlines\n\n#### Symbol: \`${built.plan.targetSymbols[0]?.symbol}\`\n\`\`\`\nfun getOrCreate()\n\`\`\``;
      return {
        plan: { ...built.plan, semanticSymbolContext: outline },
        markdown: `${built.markdown}\n\n${outline}`,
      };
    },
  };
});

const WORK_PACKAGE = `---
title: "Cap SandboxDispatcher poolCache growth"
component: "enforcer"
priority: high
target_files: ["enforcer/src/main/kotlin/io/mazewall/enforcer/SandboxDispatcher.kt"]
target_symbols: ["SandboxDispatcher#getOrCreate"]
---

**Context:** poolCache is unbounded.
**Needed:** Bound the cache at 32 entries with LRU eviction and add tests.
`;

describe("E2E plan review ladder (static → Mistral → Luna → Terra/Codex → human)", () => {
  const session = {
    version: 1 as const,
    paperclipIssueId: "issue-141",
    promptHash: "hash-141",
    promptHashVersion: 2,
    repository: "Pilleo/mazewall",
    source: "sources/github/Pilleo/mazewall",
    baseBranch: "master",
    phase: "RUNNING" as const,
    sessionId: "session-141",
    julesSessionId: "session-141",
    julesSessionUrl: "https://jules.example/session-141",
    attempt: 1,
    failedSessions: [],
    createdAt: "2026-08-30T00:00:00.000Z",
  };

  const adapterConfig = {
    env: { JULES_API_KEY: "test-key" },
    repository: "Pilleo/mazewall",
    baseBranch: "master",
    planApprovalPolicy: "trusted_opt_out" as const,
  };

  const terraSpy = vi.fn(async (input: { planMarkdown: string }) => ({
    isClear: true,
    action: "AUTO_APPROVE" as const,
    stage: "terra_codex" as const,
    reviewSummary: "[Terra/Codex] Plan approved.",
    findings: [] as string[],
    questions: [] as string[],
    seenPlan: input.planMarkdown,
  }));

  function ctx(overrides: Record<string, unknown> = {}): AdapterExecutionContext {
    return {
      agent: {
        id: "jules-1",
        companyId: "c-1",
        name: "Jules",
        adapterType: "jules",
        adapterConfig,
      },
      runtime: { sessionParams: sessionCodec.encode(session) },
      context: {
        task: {
          id: "issue-141",
          title: "Cap SandboxDispatcher poolCache growth",
          description: WORK_PACKAGE,
        },
      },
      config: adapterConfig,
      onLog: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as AdapterExecutionContext;
  }

  async function presentPlan(steps: Array<{ title: string }>) {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-141",
      state: "AWAITING_PLAN_APPROVAL",
      url: "https://jules.example/session-141",
    });
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({
      activities: [
        {
          id: "act-plan-1",
          createTime: new Date().toISOString(),
          planGenerated: { plan: { steps: steps.map((s, index) => ({ index: index + 1, ...s })) } },
        },
      ],
    });
  }

  beforeAll(() => {
    process.env.JULES_API_KEY = "test-key";
  });
  afterAll(() => {
    delete process.env.JULES_API_KEY;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    terraSpy.mockClear();
    vi.mocked(createCheapReviewer).mockReturnValue(undefined);
    vi.mocked(createTerraCodexReviewer).mockReturnValue(terraSpy as never);
    vi.mocked(JulesClient.prototype.approvePlan).mockResolvedValue({ id: "act-approved" });
  });

  it("does not call Terra/Grok when Vibe/Luna still sees gaps (TBD, no work-package answers)", async () => {
    await presentPlan([{ title: "Look into the issue and figure out cache design later (TBD)" }]);
    const result = await execute(
      ctx({
        context: { task: { id: "issue-141", title: "Mystery", description: "Do something vague." } },
      }),
    );
    expect(terraSpy).not.toHaveBeenCalled();
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
    expect(createJulesPlanApprovalInteraction).toHaveBeenCalled();
    expect(result.summary).toMatch(/operator/);
  });

  it("does not call Terra/Grok on static invariant failures", async () => {
    await presentPlan([
      { title: "Catch EPERM silently so tests pass" },
      { title: "Skip gradle test suite to speed up CI" },
    ]);
    await execute(ctx());
    expect(terraSpy).not.toHaveBeenCalled();
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
  });

  it("calls Terra/Grok only after Vibe/Luna is clean, with the full host plan including Codanna outlines", async () => {
    await presentPlan([
      { title: "Modify SandboxDispatcher.kt to add bounded cache" },
      { title: "Add unit tests in SandboxDispatcherTest.kt and run ./gradlew test" },
    ]);
    const result = await execute(ctx());
    expect(terraSpy).toHaveBeenCalledTimes(1);
    const reviewed = terraSpy.mock.calls[0]?.[0]?.planMarkdown ?? "";
    expect(reviewed).toContain("SandboxDispatcher.kt");
    expect(reviewed).toContain("SandboxDispatcher#getOrCreate");
    expect(reviewed).toContain("Codanna symbol outlines");
    expect(reviewed).toContain("fun getOrCreate()");
    expect(JulesClient.prototype.approvePlan).toHaveBeenCalledWith("session-141");
    expect(result.exitCode).toBe(0);
  });

  it("skips Terra/Grok when the cheap Vibe/Luna reviewer reports issues", async () => {
    await presentPlan([
      { title: "Modify SandboxDispatcher.kt to add bounded cache" },
      { title: "Add unit tests in SandboxDispatcherTest.kt and run ./gradlew test" },
    ]);
    vi.mocked(createCheapReviewer).mockReturnValue(async () => ({
      isClear: false,
      action: "CONTINUE",
      stage: "vibe_mistral",
      reviewSummary: "[Mistral] Missing lock order.",
      findings: ["Missing lock order"],
      questions: ["How is the mutex ordered around poolCache?"],
    }));
    const result = await execute(ctx());
    expect(terraSpy).not.toHaveBeenCalled();
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
    expect(createJulesPlanApprovalInteraction).toHaveBeenCalled();
    expect(result.summary).toMatch(/operator/);
  });

  it("pages the operator when Vibe/Luna is clean but Terra/Grok is not configured", async () => {
    await presentPlan([
      { title: "Modify SandboxDispatcher.kt to add bounded cache" },
      { title: "Add unit tests in SandboxDispatcherTest.kt and run ./gradlew test" },
    ]);
    vi.mocked(createTerraCodexReviewer).mockReturnValue(undefined);
    const result = await execute(ctx());
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
    expect(createJulesPlanApprovalInteraction).toHaveBeenCalled();
    expect(result.summary).toMatch(/operator/);
  });

  it("still does not auto-approve when planApprovalPolicy is required, even after Terra/Grok", async () => {
    await presentPlan([
      { title: "Modify SandboxDispatcher.kt to add bounded cache" },
      { title: "Add unit tests in SandboxDispatcherTest.kt and run ./gradlew test" },
    ]);
    const result = await execute(
      ctx({
        agent: {
          id: "jules-1",
          companyId: "c-1",
          name: "Jules",
          adapterType: "jules",
          adapterConfig: { ...adapterConfig, planApprovalPolicy: "required" },
        },
        config: { ...adapterConfig, planApprovalPolicy: "required" },
      }),
    );
    expect(terraSpy).toHaveBeenCalled();
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
    expect(createJulesPlanApprovalInteraction).toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });
});
