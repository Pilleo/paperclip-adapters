import { projectPrChildVerdict, type PrReviewChildIdentity } from "../../src/core/pr-review-child.js";

declare const identity: PrReviewChildIdentity;
// @ts-expect-error Verdict fields alone do not prove native card and reviewer-run provenance.
projectPrChildVerdict(identity, { kind: "answered", childId: "child", cardId: "card", reviewerRunId: "run", verdict: "approve" });
