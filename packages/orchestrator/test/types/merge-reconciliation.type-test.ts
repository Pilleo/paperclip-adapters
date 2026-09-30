import type { PullRequestReconciliationInput } from "../../src/core/pull-request-reconciliation.js";

type Observation = NonNullable<PullRequestReconciliationInput["pullRequest"]>;
// @ts-expect-error A merged observation requires an actual merge timestamp.
const missingTime: Observation = { number: 6, url: "https://github.com/acme/repo/pull/6", state: "MERGED", mergedAt: null };
// @ts-expect-error An open observation cannot claim a completed merge timestamp.
const openMerged: Observation = { number: 6, url: "https://github.com/acme/repo/pull/6", state: "OPEN", mergedAt: "2026-09-30T05:04:29Z" };
void missingTime;
void openMerged;
