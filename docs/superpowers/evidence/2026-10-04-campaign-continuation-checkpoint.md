# Campaign continuation checkpoint

Read-only observations at 2026-10-04T23:06Z, following the authorized
MAZ-1653 recovery. No recovery requests or provider mutations were sent in
this observation pass.

## Original campaign

The strict observer reports 16 done, 2 in review, 1 blocked, and 1 todo.
It still fails with `04_terminal_proof_incomplete`, the permanent PR #21
pre-merge review evidence exception.

- PR #24: pending user merge gate; Luna and strong structured native
  approvals both succeeded at `06c9c362da9a22b8323702fd2ff7efaaeb77e3af`.
- MAZ-1653 / PR #25: original session `1325682972099713236` produced
  `b5f9b79293169ef12dd3e9d3dbf54c48034fd866`. Luna run
  `886ff91d-9289-471c-93c6-817c35d5ad4c` and strong run
  `df56d89c-a68c-4902-9130-e9cccb2fbd52` succeeded with approvals at
  that exact head. User merge gate pending; GitHub reports OPEN/MERGEABLE.
- Task 20 remains todo, dependent on MAZ-1653.
- MAZ-1650 is blocked with the same provider conflict described below.

Full strict observer output:
`/home/leanid/.local/state/agent-output/run-za182x1g/stdout.log`.

## MAZ-1740 provider conflict

Failed run `c9218294-699d-49ef-b16b-b893057895b9` polled the original
session `1689905502063840609` as IN_PROGRESS at 21:00:49Z. Complete
activity reconciliation contained only one plan activity, and the durable
checkpoint had no approval effect journal. Consequently
`decidePlanProviderAction` correctly returned `hold/unverified_progress`
before observing the deferred strong-review child. This was an actual
provider-state observation, not an inference from stale local state.

A fresh direct provider GET now reports COMPLETED, update time
21:01:45.049236Z, no outputs, and complete activity history containing
only planGenerated. The existing decision code permits waiting for the
typed verdict for an outputless completed session with no approval effect.
This does not explain why the provider briefly progressed without a
recorded approval, nor authorize replaying uncertain actions.

Source remains blocked on execution action
`e30aa4f2-17fb-43fa-bd7b-ed2fbfc77160`. Original child
`1a773e4a-004a-40f6-93c6-576c79612bf3`, plan revision
`2377db52-194a-4a66-91cf-02b800846d33`, and session are preserved.
Separate explicit authorization is needed for typed recovery of this
execution hold; previous authorization concerned MAZ-1653.

## MAZ-1650 related conflict

Failed run `dbcb9a62-d37a-4313-9d63-e150bde1f66d` likewise observed
IN_PROGRESS with a single plan activity at 21:09:15Z and failed with
`native_child_plan_provider_state_conflict/unverified_progress`.
Original session `14113825466128029126` now reports COMPLETED, update
21:09:49.562031Z, with only planGenerated in its complete activity history.
Execution action `6baaa603-643e-4fa0-b10f-750fb2695d8d` remains held.
Output/effect preflight is still required before proposing its recovery.
