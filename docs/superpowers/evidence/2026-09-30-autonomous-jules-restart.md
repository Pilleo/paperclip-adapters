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
