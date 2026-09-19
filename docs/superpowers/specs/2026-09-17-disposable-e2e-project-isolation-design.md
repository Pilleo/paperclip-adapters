# Reliable Disposable Dependency Flow Design

## Objective

Prove that Paperclip adapters automatically execute an approved A -> B -> C task chain through Jules, Luna, Terra, merge reconciliation, and next-task dispatch, while remaining isolated from unrelated projects and stale test history.

## Corrected evidence

- MAZ-1531 authoritatively has blockedBy = [MAZ-1530], and MAZ-1532 has blockedBy = [MAZ-1531]. The earlier check queried the wrong convenience field; native edges are not the current defect.
- The historical Disposable E2E canary project contains 538 cards and 258 conflict edges. It is unsuitable as a deterministic fixture.
- executeAllProjects expands every heartbeat into every runnable company project, even when Paperclip supplies issue scope.
- The wake API copies payload.issueId into the run context; it does not copy payload.projectId.
- Web approval resolution wakes the requesting agent with issueId. Plugin-mediated approval resolution may carry only approvalId.
- The three manually created canary approvals have requestedByAgentId = null, so approving them cannot wake the orchestrator automatically.
- Start approvals are currently generated only from already-dispatchable candidates. This prevents early approval of dependent tasks.
- Worker routing can fall back from Jules to Vibe based on current capacity, so approval must authorize the task, not freeze a worker selected before dispatch.
- Heartbeat 087d5954-fc7a-407d-bad0-eafcd42e5198 remains running without a terminal result. Several Git subprocess paths still lack explicit timeouts.

## Design

1. Resolve heartbeat scope from projectId, issueId/taskId, or approvalId. issueId is resolved through the authoritative issue record; approvalId is resolved through the authoritative approval payload/link and then its issue. An invalid or cross-project scope fails closed. Only a truly unscoped timer heartbeat may enumerate all projects.
2. Generate task-start approvals independently from dependency, conflict, capacity, and sync eligibility. Approval authorizes the immutable issue scope. Executor selection remains a dispatch-time decision.
3. Preserve the final authoritative blockedBy detail check immediately before dispatch. Replace free-form outcomes with an exhaustive typed decision.
4. Bound every Git/GitHub subprocess used by a project tick. Do not wrap executeProject in Promise.race, because that would return while abandoned mutations continued in-process.
5. Maintain exactly one replacement disposable project in Mazewall, identified in its description by `<!-- paperclip-adapters:e2e-project:v2 -->` and reusing the existing disposable repository. Mark every canary card with `<!-- paperclip-adapters:e2e-run:<run-key> -->`. A new run is permitted only when the project has no nonterminal marked canary tasks. Never create another company or a project per run.
6. The fixture creates A, B, and C with native blocker IDs at creation, reads back blockedBy, triggers an issue-scoped orchestrator wake, and requires three native approvals requested by the orchestrator.
