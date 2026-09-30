# Autonomous Jules daemon restart qualification

## Scope

The `--autonomous` variant of
`packages/orchestrator/test/contract/jules-server-restart.mjs` owns a disposable
Paperclip daemon, real PostgreSQL, a retained private home/session store, a
stateful local Jules HTTP provider, and a local Git/gh fixture. The daemon loads
the built Jules adapter. Process-based reviewers act as external workers and
resolve their addressed native cards through the typed verdict endpoint.

Setup is sealed **before** dispatching the source issue creation. The test driver's
POST helper refuses further writes, including retries after an ambiguous failed
start. Reviewer handoffs, monitoring, result persistence and PR registration are
performed by the daemon and adapter. The test neither patches database results
nor calls timer ticks. Server stop/start and external provider output release are
explicit fault/provider actors, not control-plane rescue operations.

This case covers autonomous plan approval and same-session PR delivery across
restart. It does not yet qualify human start/merge waits, orchestrator dependency
release, realistic shared-file conflict recovery, or behavioural source mutations.

## Verification

- RED: the autonomous driver barrier test initially failed because the observer
  module did not exist.
- GREEN: three HTTP-boundary tests verify that forbidden post-start operations
  never reach the server, including after failed source creation.
- Observer and disposable daemon lifecycle tests: **7 passed**.
- Two initial real-daemon observations ended at 180 seconds during a pending
  child bootstrap. Their provider traces showed continuing scheduled polling,
  rather than a demonstrated deadlock. The adapter uses 60-second continuation
  delays and the daemon checks timers every 30 seconds; a complete two-reviewer
  ladder needs a substantially longer observer window.
- Full autonomous run:
  `node packages/orchestrator/test/contract/jules-server-restart.mjs --autonomous`
  passed in **620.766 seconds**, with one provider create, one provider approval,
  two answered native plan cards, and **zero driver mutations after source start**.
- Both daemon processes loaded `packages/jules/dist/index.js`. The original
  session checkpoint and exact native card identities survived restart; the
  resulting PR work product matched the local fixture URL and immutable head.

Captured successful run: `~/.local/state/agent-output/run-bzlcc02b/`.
The 900-second approval observation budget applies only to this fully automated
fixture. It is not a deadline for a human decision or live merge.

## Accelerated configuration qualification

The same autonomous restart case passed in **178.680 seconds** with the disposable
Paperclip scheduler set to 10 seconds, Jules provider polling at 30 seconds, and
`continuationCadenceSeconds: 10`. The earlier baseline was 620.766 seconds:
approximately **3.5× faster**, with the same real-daemon restart, exact-card and
same-session assertions and zero post-start driver mutations.

Captured accelerated run: `~/.local/state/agent-output/run-mkelb6qg/`.
Cadence validation, terminal monitor scheduling and surrounding heartbeat tests:
**55 passed**. Normal continuation configuration defaults to 60 seconds.

## Real orchestrator and ACP PR gate

The `--autonomous-merge` variant adds the actual built orchestrator and Antigravity
adapters. A local ACP provider simulator reads and submits verdicts through the
adapter-owned authenticated native-review MCP bridge. The GitHub fixture serves
its canonical repository URL through a real isolated bare Git remote, so normal
workspace synchronization remains active.

The first real runs found two protocol/fixture gaps (ACP model configuration and
the absent remote), then a real producer contract defect: the Jules terminal PR
result lacked `stopReason: "completed"`, required by the strict handoff proof.
Commit `4ea2905` fixes that defect with a failing-then-passing executor test and a
real native persisted producer check. Short-cadence runs also showed a newer
active Jules monitor fencing the completed producer. The terminal wait now
respects a continuation-sized scheduling window; live/newer-run fences remain
strict.

With the accelerated profile, the extended run passed in **237.569 seconds**:
one provider create/approval, two typed plan reviews, real server restart,
immutable terminal producer proof, two independently attributed native PR reviews,
and exactly one **pending** human merge gate. No user merge was performed.
Post-start driver mutation count remained zero.

Captured successful extended run: `~/.local/state/agent-output/run-7hjwdrw9/`.
Delayed human merge persistence and autonomous dependency release are subsequent
qualifications, not claims of this case.
