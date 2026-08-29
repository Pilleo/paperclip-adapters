/**
 * Nominal / Branded Domain Types.
 * Prevents accidental mixing of raw IDs (e.g. passing a CompanyId where an IssueId is expected).
 */

declare const _brand: unique symbol;
export type Brand<T, B> = T & { readonly [_brand]: B };

export type IssueId = Brand<string, "IssueId">;
export type CompanyId = Brand<string, "CompanyId">;
export type AgentId = Brand<string, "AgentId">;
export type PrNumber = Brand<number, "PrNumber">;
export type PrUrl = Brand<string, "PrUrl">;
export type BranchName = Brand<string, "BranchName">;
export type CommitSha = Brand<string, "CommitSha">;
export type ApprovalId = Brand<string, "ApprovalId">;

// ─── TYPE GUARDS & SMART CONSTRUCTORS ───────────────────────────────────────

export function isIssueId(val: unknown): val is IssueId {
  return typeof val === "string" && val.trim().length > 0;
}

export function asIssueId(val: string): IssueId {
  if (!isIssueId(val)) throw new Error(`Invalid IssueId: "${val}"`);
  return val as IssueId;
}

export function isCompanyId(val: unknown): val is CompanyId {
  return typeof val === "string" && val.trim().length > 0;
}

export function asCompanyId(val: string): CompanyId {
  if (!isCompanyId(val)) throw new Error(`Invalid CompanyId: "${val}"`);
  return val as CompanyId;
}

export function isAgentId(val: unknown): val is AgentId {
  return typeof val === "string" && val.trim().length > 0;
}

export function asAgentId(val: string): AgentId {
  if (!isAgentId(val)) throw new Error(`Invalid AgentId: "${val}"`);
  return val as AgentId;
}

export function isPrNumber(val: unknown): val is PrNumber {
  return typeof val === "number" && Number.isInteger(val) && val > 0;
}

export function asPrNumber(val: number): PrNumber {
  if (!isPrNumber(val)) throw new Error(`Invalid PrNumber: ${val}`);
  return val as PrNumber;
}

export function isPrUrl(val: unknown): val is PrUrl {
  return typeof val === "string" && (val.startsWith("https://") || val.startsWith("http://"));
}

export function asPrUrl(val: string): PrUrl {
  if (!isPrUrl(val)) throw new Error(`Invalid PrUrl: "${val}"`);
  return val as PrUrl;
}

export function isBranchName(val: unknown): val is BranchName {
  return typeof val === "string" && val.trim().length > 0;
}

export function asBranchName(val: string): BranchName {
  if (!isBranchName(val)) throw new Error(`Invalid BranchName: "${val}"`);
  return val as BranchName;
}

export function isCommitSha(val: unknown): val is CommitSha {
  return typeof val === "string" && /^[0-9a-fA-F]{7,40}$/.test(val);
}

export function asCommitSha(val: string): CommitSha {
  if (!isCommitSha(val)) throw new Error(`Invalid CommitSha: "${val}"`);
  return val as CommitSha;
}
