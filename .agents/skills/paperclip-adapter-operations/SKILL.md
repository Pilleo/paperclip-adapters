---
name: paperclip-adapter-operations
description: Safely reload, reconcile, and recover local Paperclip adapter workflows after an adapter change or failed native review. Use for live fleet/reviewer diagnosis and recovery, not ordinary code changes.
---

# Paperclip Adapter Operations

Use this skill for live Paperclip fleet work after an external adapter build,
or when a native Jules/Luna/Terra interaction is stuck or has failed.

## Invariants

- A native review decision exists only as a structured Paperclip verdict on its
  addressed interaction. Never use ordinary issue comments, provider prose, or
  GitHub comments as a fallback decision.
- One pending interaction has at most one active addressed reviewer run.
- A terminal reviewer run is evidence to inspect, not a reason to issue a
  duplicate wake. Recover the existing card only after no active run remains.
- An external adapter build is inert until the Paperclip process reloads it.

## Reload workflow

1. Build the changed adapter workspace and run its focused tests.
2. Restart Paperclip.
3. Confirm startup logs load the adapter package from its `dist/index.js`.
4. Let one orchestrator heartbeat reconcile the managed fleet. Verify retired
   configuration fields are gone before waking a reviewer.

## Native-review recovery

1. Read the issue's interactions and the addressed reviewer's recent runs.
2. If the existing card is answered, let the normal state machine route the
   result; do not recover it.
3. If exactly one card is pending and no reviewer run is queued/running, reuse
   the card through `packages/orchestrator/scripts/recover-native-review.mjs`.
4. Verify that same interaction becomes `answered` and inspect the verdict.
   A reject is a valid review result; transport, authentication, and runtime
   failures are not.

See [the fleet runbook](../../../scripts/fleet/README.md) for operator commands
and [the orchestrator README](../../../packages/orchestrator/README.md) for
the transport workaround and E2E harnesses.
