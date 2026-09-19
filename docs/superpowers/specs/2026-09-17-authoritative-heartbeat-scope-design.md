# Authoritative Heartbeat Scope Design

## Problem

Paperclip can preserve an on-demand wake's scope in the heartbeat run's
`contextSnapshot` while omitting it from the adapter invocation's `context`.
The orchestrator currently treats an empty invocation context as an unscoped
timer and runs every project. A project-scoped canary therefore caused
unrelated repositories and tasks to be reconciled before the run was
cancelled.

An issue-scoped wake is not a usable workaround: Paperclip's queued-run guard
cancels an orchestrator wake for an unassigned issue because the issue is not
already assigned to the orchestrator. A project-scoped wake is the correct
adapter entrypoint, but its scope must be recovered from the authoritative run
record.

## Safety invariants

1. A missing scope is never interpreted as permission to process every
   project.
2. Only a heartbeat run with positive scheduler evidence may process all
   projects.
3. An on-demand heartbeat must resolve to exactly one project, issue, or
   approval before project enumeration or state-machine execution.
4. The heartbeat run ID and agent ID must match the current adapter invocation.
5. Conflicting invocation and run-record scope evidence fails closed.
6. Failure to read or validate the authoritative run record performs no board
   mutation and returns a non-zero adapter result.
7. Task-start approval remains mandatory: a scoped wake may create a native
   approval, but it may not assign or start the task before that approval is
   answered.

## State model

The scope resolver produces one exhaustive result:

- `scoped`: one `project`, `issue`, or `approval` reference, derived from the
  authoritative heartbeat run.
- `timer`: positive timer evidence (`source=scheduler`,
  `reason=interval_elapsed`, and no on-demand override), permitting all
  projects.
- `invalid`: missing run identity, failed lookup, mismatched run/agent,
  conflicting evidence, malformed reserved envelope, or an on-demand wake
  without scope.

`executeAllProjects` resolves this state before `listProjects`. `invalid`
returns immediately. `scoped` lists projects and runs exactly one resolved
project. `timer` retains the existing bounded per-project worker pool.

## Compatibility envelope

Until Paperclip persists arbitrary wake payloads through wake coalescing, the
real canary encodes its project ID in:

```text
paperclip-orchestrator-scope/v1/project/<project-id>
```

The envelope is valid only when the authoritative run snapshot reports
`wakeSource=on_demand`. The ordinary `payload.projectId` remains present for
future Paperclip versions, but it is not trusted as the sole evidence.

## Verification

Parameterized pure tests cover every state and conflict combination. HTTP
tests cover the exact run lookup. Integration tests prove that an empty
invocation context plus a scoped authoritative snapshot runs one project, and
that lookup failure or an unscoped on-demand wake runs none. The complete
orchestrator suite and build must pass before reload.

Live verification uses the existing disposable project and existing
MAZ-1533 → MAZ-1534 → MAZ-1535 chain. The first scoped heartbeat must create
exactly one pending task-start approval for MAZ-1533 while all three issues
remain unassigned and without execution runs. Subsequent tasks may become
eligible only after their dependency reaches `done`.

## Upstream cleanup

When Paperclip reliably includes typed wake scope in every adapter invocation,
remove the reason envelope and authoritative compatibility fallback. Keep the
fail-closed classifier and explicit timer state: absence of context must never
again mean company-wide authority.
