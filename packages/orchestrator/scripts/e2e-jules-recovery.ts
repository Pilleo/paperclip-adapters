import path from "node:path";
import { projectRecoveryCanaryState } from "../src/core/recovery-canary-state.js";

/**
 * Fast, destructive-by-design E2E canary for the Jules open-PR recovery path.
 *
 * It is destructive only inside a newly-created Paperclip company. GitHub and
 * Jules are represented by a temporary `gh` fixture, so this test cannot spend
 * provider quota or mutate a real repository. The explicit API URL guard is
 * intentional: invoking this against the default board must be a conscious
 * choice, not an accidental local default.
 */
const apiUrl = process.env["PAPERCLIP_TEST_API_URL"]?.replace(/\/+$/, "");
const workspacePath = path.resolve(process.env["WORKSPACE_PATH"] || process.cwd());

type Json = Record<string, any> | any[] | null;

async function request(pathname: string, method: string, body?: unknown): Promise<Json> {
  const response = await fetch(`${apiUrl}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let value: Json = null;
  try { value = text ? JSON.parse(text) as Json : null; } catch { value = text as any; }
  if (!response.ok) throw new Error(`${method} ${pathname} failed (${response.status}): ${text.slice(0, 500)}`);
  return value;
}

function requireObject(value: Json, label: string): Record<string, any> {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${label} response was not an object`);
  return value;
}

async function waitForIssueExecution(issueId: string, initialRunId: string, label: string): Promise<void> {
  let runId = initialRunId;
  const seenSuccessors = new Set<string>([initialRunId]);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const run = requireObject(await request(`/api/heartbeat-runs/${runId}`, "GET"), `${label} heartbeat run`);
    const status = String(run.status);
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(status)) {
      if (status === "succeeded") return;
      const result = run.resultJson && typeof run.resultJson === "object" ? run.resultJson as Record<string, unknown> : null;
      const handoffCancellation = status === "cancelled" && result?.["stopReason"] === "issue_assignee_changed";
      if (handoffCancellation) {
        // Assignment wakeup is deliberately asynchronous in Paperclip. Give
        // it a short bounded window to stamp the successor execution lock;
        // reading once here races the cancellation transaction and falsely
        // reports a lost worker.
        let successorRunId = "";
        for (let handoffAttempt = 0; handoffAttempt < 20; handoffAttempt += 1) {
          const issue = requireObject(await request(`/api/issues/${issueId}`, "GET"), `${label} handoff issue`);
          const successor = typeof issue.executionRunId === "string" ? issue.executionRunId : "";
        if (successor && successor !== runId) {
          if (seenSuccessors.has(successor)) throw new Error(`${label} execution looped on heartbeat ${successor}`);
          seenSuccessors.add(successor);
          successorRunId = successor;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (successorRunId) {
          runId = successorRunId;
          continue;
        }
      }
      throw new Error(`${label} heartbeat failed: ${JSON.stringify({ status, error: run.error, resultJson: run.resultJson })}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} heartbeat did not finish: ${runId}`);
}

function pendingReviewCards(value: Json): Record<string, any>[] {
  return (Array.isArray(value) ? value : []).filter((interaction) =>
    interaction && typeof interaction === "object" &&
    interaction.kind === "request_item_verdicts" && interaction.status === "pending",
  ) as Record<string, any>[];
}

async function submitReviewVerdict(issueId: string, interactionId: string, verdict: "approve" | "reject", reason?: string): Promise<void> {
  await request(`/api/issues/${issueId}/interactions/${interactionId}/verdicts`, "POST", {
    verdicts: [{ id: "pull_request", verdict, ...(reason ? { reason } : {}) }],
  });
}

async function main(): Promise<void> {
  if (!apiUrl) throw new Error("PAPERCLIP_TEST_API_URL is required; refusing to run against an implicit board");
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(apiUrl)) {
    throw new Error(`Recovery canary accepts only a loopback Paperclip API, got ${apiUrl}`);
  }
  // The orchestrator is a separate Paperclip process and invokes `gh` there.
  // A PATH change in this client cannot provide the fixture. CI sets this
  // marker only in the same server-start step that installs the fixture;
  // refusing an unmarked server prevents a false-positive/false-negative
  // canary that creates disposable board data without exercising GitHub.
  if (process.env["PAPERCLIP_E2E_GH_FIXTURE"] !== "server") {
    throw new Error(
      "Recovery canary requires a server-owned GitHub fixture. Start Paperclip with the deterministic gh fixture and set PAPERCLIP_E2E_GH_FIXTURE=server.",
    );
  }
  const health = requireObject(await request("/api/health", "GET"), "health");
  if (health.status !== "ok") throw new Error("Paperclip health check failed");

  // A clean Paperclip install knows no repository-local external adapters.
  // Install the built artifacts through the same admin API used in production
  // before creating canary agents; otherwise this test only exercises builtins.
  for (const packageDir of ["packages/orchestrator", "packages/jules", "packages/vibe"]) {
    await request("/api/adapters/install", "POST", {
      packageName: path.join(workspacePath, packageDir),
      isLocalPath: true,
    });
  }
  const installedAdapters = await request("/api/adapters", "GET");
  const adapterTypes = new Set((Array.isArray(installedAdapters) ? installedAdapters : [])
    .map((adapter) => adapter && typeof adapter === "object" ? (adapter as Record<string, unknown>).type : undefined));
  for (const requiredType of ["orchestrator", "jules", "vibe"]) {
    if (!adapterTypes.has(requiredType)) {
      throw new Error(`Clean-server canary did not install external adapter ${requiredType}`);
    }
  }

  let companyId = "";
  let cleanupError: unknown;
  let operationError: unknown;
  try {
    const company = requireObject(await request("/api/companies", "POST", { name: `Jules recovery canary ${Date.now()}` }), "company");
    companyId = String(company.id || "");
    if (!companyId) throw new Error("Paperclip did not return a canary company id");

    const project = requireObject(await request(`/api/companies/${companyId}/projects`, "POST", {
      name: `Jules recovery workspace ${Date.now()}`,
      description: "Disposable workspace for the Jules recovery canary",
    }), "project");
    if (!project.id) throw new Error("Paperclip did not return a canary project id");
    const projectWorkspace = requireObject(await request(`/api/projects/${project.id}/workspaces`, "POST", {
      name: "Canary local workspace",
      sourceType: "local_path",
      cwd: workspacePath,
      isPrimary: true,
    }), "project workspace");
    if (!projectWorkspace.id || projectWorkspace.cwd !== workspacePath || projectWorkspace.isPrimary !== true) {
      throw new Error(`Paperclip did not persist the primary canary workspace: ${JSON.stringify(projectWorkspace)}`);
    }

    const orch = requireObject(await request(`/api/companies/${companyId}/agents`, "POST", {
      name: "Canary Orchestrator", role: "ceo", adapterType: "orchestrator",
      // The real server runner supplies this adapter configuration as the
      // heartbeat context. Enable fleet reconciliation so the canary fails
      // loudly if the canonical Luna/Terra reviewer identities cannot be
      // provisioned, rather than silently producing no review card.
      adapterConfig: { reconcileFleet: true, apiUrl, backlogDirectory: ".paperclip-canary-empty" },
      permissions: { canCreateAgents: true, canCreateSkills: true, canAssignTasks: true, trustPreset: "standard" },
    }), "orchestrator agent");
    const jules = requireObject(await request(`/api/companies/${companyId}/agents`, "POST", {
      name: "Canary Jules", role: "general", adapterType: "jules", reportsTo: orch.id,
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } },
      metadata: { managedBy: "paperclip-orchestrator" },
    }), "Jules agent");
    const vibe = requireObject(await request(`/api/companies/${companyId}/agents`, "POST", {
      name: "Canary Vibe", role: "general", adapterType: "vibe", reportsTo: orch.id,
      metadata: { managedBy: "paperclip-orchestrator" },
    }), "Vibe agent");
    void vibe;
    // Disposable companies created by the local board may not grant the
    // orchestrator agents:create capability. Provision the reviewer
    // identities explicitly so this canary tests review routing, not fleet
    // authorization policy. Disable their scheduled heartbeats; the canary
    // asserts card binding and duplicate suppression before a model is woken.
    const luna = requireObject(await request(`/api/companies/${companyId}/agents`, "POST", {
      name: "[Orchestrated] Luna Fast Reviewer", role: "qa", adapterType: "codex_local",
      reportsTo: orch.id, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      metadata: { managedBy: "paperclip-orchestrator", workerKey: "luna_reviewer" },
    }), "Luna reviewer");
    const terra = requireObject(await request(`/api/companies/${companyId}/agents`, "POST", {
      name: "[Orchestrated] Terra Strong Reviewer", role: "qa", adapterType: "codex_local",
      reportsTo: orch.id, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      metadata: { managedBy: "paperclip-orchestrator", workerKey: "terra_reviewer" },
    }), "Terra reviewer");
    await request(`/api/agents/${orch.id}`, "PATCH", {
      adapterConfig: {
        reconcileFleet: true,
        apiUrl,
        backlogDirectory: ".paperclip-canary-empty",
        lunaReviewerAgentId: luna.id,
        terraReviewerAgentId: terra.id,
      },
    });
    // Canonicalize the managed fleet before introducing the PR. The bootstrap
    // run has no actionable issue, so it can safely install reviewer protocol
    // metadata without launching a reviewer. Afterwards freeze fleet mutation
    // and disable on-demand reviewer execution; verdicts below use native API
    // forms and must never consume model credentials or quota.
    const bootstrapWake = requireObject(await request(`/api/agents/${orch.id}/wakeup`, "POST", {
      source: "on_demand",
      reason: "e2e_jules_recovery_canary_fleet_bootstrap",
      idempotencyKey: `e2e-jules-recovery:${companyId}:fleet-bootstrap`,
      payload: {},
    }), "fleet bootstrap wake");
    const bootstrapRunId = String(bootstrapWake.id || "");
    if (!bootstrapRunId) throw new Error(`Paperclip bootstrap wake did not return a heartbeat run: ${JSON.stringify(bootstrapWake)}`);
    await waitForIssueExecution("", bootstrapRunId, "Fleet bootstrap");
    for (const nonExecutableAgent of [jules, luna, terra]) {
      await request(`/api/agents/${nonExecutableAgent.id}`, "PATCH", {
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } },
      });
    }
    await request(`/api/agents/${orch.id}`, "PATCH", {
      adapterConfig: {
        reconcileFleet: false,
        apiUrl,
        backlogDirectory: ".paperclip-canary-empty",
        lunaReviewerAgentId: luna.id,
        terraReviewerAgentId: terra.id,
      },
    });
    const marker = `e2e-jules-recovery-${Date.now()}`;
    const issue = requireObject(await request(`/api/companies/${companyId}/issues`, "POST", {
      title: marker,
      description: `---\norchestrator_managed: true\nopen_questions: false\ntarget_modules: [":e2e"]\ntarget_files: ["${marker}.txt"]\n---\n\n# Jules recovery canary`,
      // Do not assign the issue to Jules during fixture creation. Paperclip
      // immediately starts an assigned issue, which races the orchestrator
      // wake and makes the canary test the wrong state machine. The real
      // recovery path starts from an active, unassigned managed issue.
      // Start at the recovery boundary. A todo issue would correctly stop at
      // Paperclip's human task-start approval gate and would never exercise
      // the PR-review recovery state machine this canary targets.
      status: "in_review",
      priority: "high",
      projectId: project.id,
    }), "canary issue");
    const issueId = String(issue.id || "");
    if (!issueId) throw new Error("Paperclip did not return a canary issue id");

    // The server process receives a deterministic `gh` fixture from the CI
    // harness before it starts. The adapter, not this client process, invokes
    // `gh`; this verifies the actual external-adapter process boundary.
    const prUrl = "https://github.com/example/canary/pull/991";
    await request(`/api/issues/${issueId}/work-products`, "POST", {
      type: "pull_request", provider: "github", title: "Canary Jules PR", url: prUrl,
      externalId: prUrl, status: "ready_for_review", isPrimary: true, metadata: { source: "jules" },
    });
    const childIds: string[] = [];
    for (const markerText of ["jules-session-supervisor", "jules-question-adjudication"]) {
      const child = requireObject(await request(`/api/issues/${issueId}/children`, "POST", {
        title: `${marker} stale child`, description: `${markerText} canary`, status: "todo", priority: "medium",
      }), "child");
      childIds.push(String(child.id));
    }
    const wake = requireObject(await request(`/api/agents/${orch.id}/wakeup`, "POST", {
      source: "on_demand",
      reason: "e2e_jules_recovery_canary",
      idempotencyKey: `e2e-jules-recovery:${issueId}:orchestrator`,
      // The scheduler heartbeat is company-scoped. Supplying issueId would
      // make Paperclip bind the run to the issue and then cancel that run as
      // soon as the scheduler assigns the issue to Jules.
      payload: {},
    }), "orchestrator wake");
    const runId = String(wake.id || "");
    if (!runId) throw new Error(`Paperclip wake did not return a heartbeat run: ${JSON.stringify(wake)}`);
    await waitForIssueExecution(issueId, runId, "Orchestrator");
    const recovered = requireObject(await request(`/api/issues/${issueId}`, "GET"), "recovered issue");
    const recoveredInteractions = await request(`/api/issues/${issueId}/interactions`, "GET");
    const pendingCards = (Array.isArray(recoveredInteractions) ? recoveredInteractions : [])
      .filter((interaction) => interaction && typeof interaction === "object" &&
        interaction.kind === "request_item_verdicts" && interaction.status === "pending");
    const lunaCard = pendingCards.find((interaction) =>
      String(interaction.idempotencyKey || "").endsWith(":luna") &&
      interaction.addresseeAgentId === luna.id &&
      interaction.continuationPolicy === "none",
    );
    if (recovered.status !== "in_review" || recovered.assigneeAgentId !== luna.id || pendingCards.length !== 1 || !lunaCard) {
      const canaryAgents = await request(`/api/companies/${companyId}/agents`, "GET");
      const canaryComments = await request(`/api/issues/${issueId}/comments`, "GET");
      throw new Error(`Canary did not enter native review: ${JSON.stringify({
        status: recovered.status,
        assigneeAgentId: recovered.assigneeAgentId,
        pendingReviewCards: pendingCards.length,
        pendingCardSummaries: pendingCards.map((card) => ({
          id: card.id,
          kind: card.kind,
          status: card.status,
          idempotencyKey: card.idempotencyKey,
          addresseeAgentId: card.addresseeAgentId,
          continuationPolicy: card.continuationPolicy,
        })),
        expectedLunaAgentId: luna.id,
        executionPolicy: recovered.executionPolicy ?? null,
        executionState: recovered.executionState ?? null,
        agents: canaryAgents,
        comments: canaryComments,
      })}`);
    }
    for (const childId of childIds) {
      const child = requireObject(await request(`/api/issues/${childId}`, "GET"), "stale child");
      if (child.status !== "done") throw new Error(`Stale child ${childId} was not closed`);
    }

    // Reproduce the host projection observed after a hot restart: the PR card
    // survived, but Paperclip put its source back in backlog and left an old
    // Jules plan card alongside it. The recovery must retain the exact PR
    // card, withdraw only the stale plan card, and restore the native review
    // projection. No model credentials are involved in this assertion.
    const stalePlan = requireObject(await request(`/api/issues/${issueId}/interactions`, "POST", {
      kind: "request_item_verdicts",
      idempotencyKey: `jules:plan-review:v2:${issueId}:canary-session:revision-1:luna`,
      title: "Stale Jules plan review",
      summary: "Disposable stale plan card for native review recovery.",
      addresseeAgentId: luna.id,
      continuationPolicy: "wake_assignee",
      resolverPolicy: "anyone",
      payload: {
        version: 1,
        prompt: "Disposable stale plan card.",
        detailsMarkdown: "This card must be withdrawn by the recovery canary.",
        items: [{ id: "plan", label: "Plan", description: "Stale plan" }],
        verdicts: ["approve", "reject"],
        requireReasonOn: ["reject"],
        reasonLabel: "What must change?",
        allowBulkApprove: true,
        supersedeOnUserComment: false,
      },
    }), "stale Jules plan card");
    // Recovery candidates are Jules-owned. Assign only after fleet bootstrap
    // and after explicitly making this synthetic Jules agent non-invokable;
    // the final zero-run assertion protects hosts with global credentials.
    await request(`/api/issues/${issueId}`, "PATCH", { status: "backlog", assigneeAgentId: jules.id });
    const recoveryWake = requireObject(await request(`/api/agents/${orch.id}/wakeup`, "POST", {
      source: "on_demand",
      reason: "e2e_jules_recovery_canary_restart_projection",
      idempotencyKey: `e2e-jules-recovery:${issueId}:orchestrator:restart-projection`,
      payload: {},
    }), "recovery orchestrator wake");
    const recoveryRunId = String(recoveryWake.id || "");
    if (!recoveryRunId) throw new Error(`Paperclip recovery wake did not return a heartbeat run: ${JSON.stringify(recoveryWake)}`);
    await waitForIssueExecution(issueId, recoveryRunId, "Recovery orchestrator");
    const repeated = requireObject(await request(`/api/issues/${issueId}`, "GET"), "repeated issue");
    const childrenAfter = await request(`/api/companies/${companyId}/issues?parentId=${encodeURIComponent(issueId)}`, "GET");
    const interactionsAfter = await request(`/api/issues/${issueId}/interactions`, "GET");
    const issueAfter = await request(`/api/issues/${issueId}`, "GET");
    const recoveredPrCards = pendingReviewCards(interactionsAfter);
    const recoveredLunaCard = recoveredPrCards.find((card) => String(card.id) === String(lunaCard.id));
    const stalePlanAfter = (Array.isArray(interactionsAfter) ? interactionsAfter : []).find((card) =>
      card && typeof card === "object" && String((card as Record<string, unknown>).id) === String(stalePlan.id),
    ) as Record<string, unknown> | undefined;
    if (repeated.status !== "in_review" || repeated.assigneeAgentId !== luna.id ||
        recoveredPrCards.length !== 1 || !recoveredLunaCard || stalePlanAfter?.status !== "cancelled") {
      throw new Error(`Canary did not recover the typed PR review authority: ${JSON.stringify({
        status: repeated.status,
        assigneeAgentId: repeated.assigneeAgentId,
        expectedPrCardId: lunaCard.id,
        pendingCards: recoveredPrCards,
        stalePlan: stalePlanAfter ?? null,
      })}`);
    }
    const childrenBefore = childrenAfter;
    const interactionsBefore = interactionsAfter;
    const issueBefore = issueAfter;
    const repeatWake = requireObject(await request(`/api/agents/${orch.id}/wakeup`, "POST", {
      source: "on_demand",
      reason: "e2e_jules_recovery_canary_repeat",
      idempotencyKey: `e2e-jules-recovery:${issueId}:orchestrator:repeat`,
      payload: {},
    }), "repeat orchestrator wake");
    const repeatRunId = String(repeatWake.id || "");
    if (!repeatRunId) throw new Error(`Paperclip repeat wake did not return a heartbeat run: ${JSON.stringify(repeatWake)}`);
    await waitForIssueExecution(issueId, repeatRunId, "Repeat orchestrator");
    const idempotentIssue = requireObject(await request(`/api/issues/${issueId}`, "GET"), "idempotent issue");
    const idempotentChildren = await request(`/api/companies/${companyId}/issues?parentId=${encodeURIComponent(issueId)}`, "GET");
    const idempotentInteractions = await request(`/api/issues/${issueId}/interactions`, "GET");
    const beforeState = projectRecoveryCanaryState({
      issue: issueBefore,
      children: Array.isArray(childrenBefore) ? childrenBefore : [],
      interactions: Array.isArray(interactionsBefore) ? interactionsBefore : [],
    });
    const afterState = projectRecoveryCanaryState({
      issue: idempotentIssue,
      children: Array.isArray(idempotentChildren) ? idempotentChildren : [],
      interactions: Array.isArray(idempotentInteractions) ? idempotentInteractions : [],
    });
    if (JSON.stringify(beforeState) !== JSON.stringify(afterState) ||
        idempotentIssue.status !== "in_review") {
      throw new Error(`Canary recovery was not idempotent: ${JSON.stringify({
        status: idempotentIssue.status,
        assigneeAgentId: idempotentIssue.assigneeAgentId,
        beforeState,
        afterState,
        workProducts: idempotentIssue.workProducts ?? idempotentIssue.work_products ?? null,
        executionPolicy: idempotentIssue.executionPolicy ?? null,
        executionState: idempotentIssue.executionState ?? null,
      })}`);
    }

    // Drive both canonical reviewer stages through their native verdict API.
    // This is deliberately board-level: it verifies the real external
    // orchestrator sees the answered card and advances exactly one stage.
    const firstCards = pendingReviewCards(idempotentInteractions);
    const answeredLunaCard = firstCards.find((card) =>
      String(card.idempotencyKey || "").endsWith(":luna") &&
      card.addresseeAgentId === luna.id,
    );
    if (!answeredLunaCard) throw new Error("Canary did not create a Luna review card addressed to Luna");
    await submitReviewVerdict(issueId, String(answeredLunaCard.id), "approve");
    const lunaWake = requireObject(await request(`/api/agents/${orch.id}/wakeup`, "POST", {
      source: "on_demand", reason: "e2e_luna_verdict", idempotencyKey: `e2e-jules-recovery:${issueId}:luna-verdict`, payload: {},
    }), "Luna verdict wake");
    await waitForIssueExecution(issueId, String(lunaWake.id), "Luna verdict");
    const afterLuna = await request(`/api/issues/${issueId}/interactions`, "GET");
    const terraCards = pendingReviewCards(afterLuna).filter((card) =>
      String(card.idempotencyKey || "").endsWith(":terra") &&
      card.addresseeAgentId === terra.id &&
      card.continuationPolicy === "none",
    );
    const terraCard = terraCards[0];
    if (terraCards.length !== 1 || !terraCard) throw new Error(`Canary did not advance to exactly one native Terra card: ${JSON.stringify(afterLuna)}`);
    await submitReviewVerdict(issueId, String(terraCard.id), "approve");
    const terraWake = requireObject(await request(`/api/agents/${orch.id}/wakeup`, "POST", {
      source: "on_demand", reason: "e2e_terra_verdict", idempotencyKey: `e2e-jules-recovery:${issueId}:terra-verdict`, payload: {},
    }), "Terra verdict wake");
    await waitForIssueExecution(issueId, String(terraWake.id), "Terra verdict");
    const approvals = await request(`/api/companies/${companyId}/approvals`, "GET");
    const mergeApprovals = (Array.isArray(approvals) ? approvals : []).filter((approval) =>
      approval && typeof approval === "object" && (() => {
        const candidate = approval as Record<string, any>;
        const payload = candidate.payload && typeof candidate.payload === "object" ? candidate.payload : {};
        const isMergeType = candidate.type === "task_merge_approval" ||
          (candidate.type === "request_board_approval" && payload.action === "task_merge");
        const belongsToIssue = payload.issueId === issueId ||
          (Array.isArray(candidate.issueIds) && candidate.issueIds.includes(issueId));
        return isMergeType && belongsToIssue;
      })(),
    );
    if (mergeApprovals.length !== 1) throw new Error(`Canary did not create exactly one issue-scoped merge approval: ${JSON.stringify(approvals)}`);
    const companyRuns = await request(`/api/companies/${companyId}/heartbeat-runs`, "GET");
    const julesRuns = (Array.isArray(companyRuns) ? companyRuns : []).filter((run) =>
      run && typeof run === "object" && (run as Record<string, unknown>).agentId === jules.id,
    );
    if (julesRuns.length !== 0) throw new Error(`Recovery canary unexpectedly executed Jules: ${JSON.stringify(julesRuns)}`);
    console.log("Jules recovery canary passed: Luna → Terra → merge approval, recovery, cleanup, and idempotency verified.");
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (companyId) {
      try {
        const res = await fetch(`${apiUrl}/api/companies/${companyId}`, { method: "DELETE" });
        if (!res.ok) {
          throw new Error(`company deletion returned HTTP ${res.status}`);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === "EPERM" || code === "EACCES") {
          throw new Error(`company deletion failed with ${code}`);
        }
        cleanupError = error;
      }
    }
    if (cleanupError && !operationError) {
      throw new Error(`Canary cleanup failed; disposable company ${companyId} may remain: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    if (cleanupError && operationError) {
      console.error(`Canary cleanup also failed; disposable company ${companyId} may remain: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error("Jules recovery canary failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
