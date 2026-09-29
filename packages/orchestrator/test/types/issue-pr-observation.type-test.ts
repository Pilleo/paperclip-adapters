import type { IssuePullRequestObservation } from "../../src/core/github-sync.js";
import type { GitHubPullRequest } from "../../src/core/types.js";

declare const pr: GitHubPullRequest;

const observed: IssuePullRequestObservation = { kind: "remote_open", pr };
const unavailable: IssuePullRequestObservation = { kind: "unavailable", error: "gh timed out" };
void observed;
void unavailable;

// @ts-expect-error A failed GitHub read cannot contain a confirmed remote PR.
const unavailableWithRemote: IssuePullRequestObservation = { kind: "unavailable", error: "gh timed out", pr };
// @ts-expect-error A remote-open observation requires the observed PR record.
const remoteWithoutPr: IssuePullRequestObservation = { kind: "remote_open" };
// @ts-expect-error Registered fallback requires the Paperclip work product identity.
const fallbackWithoutProduct: IssuePullRequestObservation = { kind: "registered_after_unavailable", error: "gh timed out" };
// @ts-expect-error Bounded discovery is not authoritative absence and has no remote field.
const absentRemote: GitHubPullRequest = ({} as IssuePullRequestObservation).pr;
void unavailableWithRemote;
void remoteWithoutPr;
void fallbackWithoutProduct;
void absentRemote;

// @ts-expect-error A merged GitHub PR must carry an authoritative merge timestamp.
const mergedWithoutTimestamp: GitHubPullRequest = { ...pr, state: "MERGED", mergedAt: null };
// @ts-expect-error An open PR cannot simultaneously declare a completed merge.
const openWithMergeTimestamp: GitHubPullRequest = { ...pr, state: "OPEN", mergedAt: "2026-09-29T01:00:00Z" };
void mergedWithoutTimestamp;
void openWithMergeTimestamp;

function exhaustive(observation: IssuePullRequestObservation): GitHubPullRequest | undefined {
  switch (observation.kind) {
    case "remote_open": return observation.pr;
    case "registered_after_unavailable": return observation.registered;
    case "registered_outside_window": return observation.registered;
    case "unavailable": return undefined;
    case "not_in_window": return undefined;
    default: {
      const impossible: never = observation;
      return impossible;
    }
  }
}
void exhaustive;
