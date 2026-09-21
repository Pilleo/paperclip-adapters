import { extractIssueMetadata } from "./parser.js";

export interface CanaryIssueSnapshot {
  readonly id: string;
  readonly status: string;
  readonly orchestratorManaged: boolean;
  readonly blockedBy: readonly { readonly id: string; readonly status: string }[];
  readonly assigneeAgentId?: string | null;
  readonly executionRunId?: string | null;
  readonly workProducts: readonly { readonly type?: string; readonly status?: string; readonly url?: string | null }[];
}

export type CanaryDependencyProgress =
  | { readonly kind: "await_a"; readonly activeIssueId: string }
  | { readonly kind: "await_b"; readonly activeIssueId: string }
  | { readonly kind: "await_c"; readonly activeIssueId: string }
  | { readonly kind: "complete" }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * A live Paperclip response is untrusted transport data.  Keep its validation
 * at this boundary so a partially-shaped response cannot accidentally be
 * interpreted as permission to dispatch a dependent canary.
 */
type CanarySnapshotInvalidReason =
  | "missing_id"
  | "missing_status"
  | "missing_description"
  | "malformed_blockers"
  | "malformed_work_products";

export function parseCanaryIssueSnapshot(raw: unknown): CanaryIssueSnapshot | { readonly kind: "invalid_snapshot"; readonly reason: CanarySnapshotInvalidReason } {
  if (!isRecord(raw)) return { kind: "invalid_snapshot", reason: "missing_id" };

  const id = requiredString(raw, "id");
  if (!id) return { kind: "invalid_snapshot", reason: "missing_id" };
  const status = requiredString(raw, "status");
  if (!status) return { kind: "invalid_snapshot", reason: "missing_status" };
  const description = requiredString(raw, "description");
  if (!description) return { kind: "invalid_snapshot", reason: "missing_description" };
  const blockedBy = parseBlockers(raw["blockedBy"]);
  if (!blockedBy) return { kind: "invalid_snapshot", reason: "malformed_blockers" };
  const workProducts = parseWorkProducts(raw["workProducts"]);
  if (!workProducts) return { kind: "invalid_snapshot", reason: "malformed_work_products" };

  const metadata = extractIssueMetadata({
    id,
    title: typeof raw["title"] === "string" ? raw["title"] : id,
    status,
    description,
    priority: typeof raw["priority"] === "string" ? raw["priority"] : undefined,
  });
  return {
    id,
    status,
    orchestratorManaged: metadata.orchestratorManaged,
    blockedBy,
    assigneeAgentId: optionalString(raw["assigneeAgentId"]),
    executionRunId: optionalString(raw["executionRunId"]),
    workProducts,
  };
}

export function evaluateCanaryDependencyProgress(input: {
  readonly julesAgentId: string;
  readonly a: CanaryIssueSnapshot;
  readonly b: CanaryIssueSnapshot;
  readonly c: CanaryIssueSnapshot;
}): CanaryDependencyProgress {
  const contract = validateChainContract(input.a, input.b, input.c);
  if (contract) return contract;

  if (!isDone(input.a)) {
    const held = validateHeldDescendant(input.b, input.a.id, "b", "a", input.julesAgentId);
    if (held) return held;
    const transitiveHeld = validateHeldDescendant(input.c, input.b.id, "c", "b", input.julesAgentId);
    if (transitiveHeld) return transitiveHeld;
    return { kind: "await_a", activeIssueId: input.a.id };
  }
  const aProduct = validateMergedPullRequest(input.a, "a");
  if (aProduct) return aProduct;

  if (!isDone(input.b)) {
    const held = validateHeldDescendant(input.c, input.b.id, "c", "b", input.julesAgentId);
    if (held) return held;
    return { kind: "await_b", activeIssueId: input.b.id };
  }
  const bProduct = validateMergedPullRequest(input.b, "b");
  if (bProduct) return bProduct;

  if (!isDone(input.c)) return { kind: "await_c", activeIssueId: input.c.id };
  const cProduct = validateMergedPullRequest(input.c, "c");
  return cProduct ?? { kind: "complete" };
}

function validateChainContract(a: CanaryIssueSnapshot, b: CanaryIssueSnapshot, c: CanaryIssueSnapshot): CanaryDependencyProgress | null {
  for (const [name, issue] of [["a", a], ["b", b], ["c", c]] as const) {
    if (!issue.orchestratorManaged) return { kind: "invalid", reason: `${name}_unmanaged` };
  }
  if (!hasOnlyBlocker(b, a.id)) return { kind: "invalid", reason: "b_missing_authoritative_blocker" };
  if (!hasOnlyBlocker(c, b.id)) return { kind: "invalid", reason: "c_missing_authoritative_blocker" };
  return null;
}

function validateHeldDescendant(
  issue: CanaryIssueSnapshot,
  expectedBlockerId: string,
  name: "b" | "c",
  predecessor: "a" | "b",
  julesAgentId: string,
): CanaryDependencyProgress | null {
  if (!hasOnlyBlocker(issue, expectedBlockerId)) return { kind: "invalid", reason: `${name}_missing_authoritative_blocker` };
  const started = issue.status === "in_progress" || issue.status === "in_review" || issue.status === "done" ||
    issue.assigneeAgentId === julesAgentId || Boolean(issue.executionRunId) || hasPullRequest(issue);
  return started ? { kind: "invalid", reason: `${name}_started_before_${predecessor}_terminal` } : null;
}

function validateMergedPullRequest(issue: CanaryIssueSnapshot, name: "a" | "b" | "c"): CanaryDependencyProgress | null {
  const merged = issue.workProducts.filter((product) => product.type === "pull_request" && product.status === "merged" && Boolean(product.url));
  return merged.length === 1 ? null : { kind: "invalid", reason: `${name}_missing_merged_pull_request` };
}

function hasOnlyBlocker(issue: CanaryIssueSnapshot, expectedId: string): boolean {
  return issue.blockedBy.length === 1 && issue.blockedBy[0]?.id === expectedId;
}

function hasPullRequest(issue: CanaryIssueSnapshot): boolean {
  return issue.workProducts.some((product) => product.type === "pull_request" && Boolean(product.url));
}

function isDone(issue: CanaryIssueSnapshot): boolean {
  return issue.status === "done";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseBlockers(value: unknown): readonly { readonly id: string; readonly status: string }[] | null {
  if (!Array.isArray(value)) return null;
  const blockers: { id: string; status: string }[] = [];
  for (const blocker of value) {
    if (!isRecord(blocker)) return null;
    const id = requiredString(blocker, "id");
    const status = requiredString(blocker, "status");
    if (!id || !status) return null;
    blockers.push({ id, status });
  }
  return blockers;
}

function parseWorkProducts(value: unknown): readonly { readonly type?: string; readonly status?: string; readonly url?: string | null }[] | null {
  if (!Array.isArray(value)) return null;
  const products: { type?: string; status?: string; url?: string | null }[] = [];
  for (const product of value) {
    if (!isRecord(product)) return null;
    const type = optionalString(product["type"]);
    const status = optionalString(product["status"]);
    const url = optionalString(product["url"]);
    products.push({
      ...(type === null ? {} : { type }),
      ...(status === null ? {} : { status }),
      ...(url === null ? {} : { url }),
    });
  }
  return products;
}
