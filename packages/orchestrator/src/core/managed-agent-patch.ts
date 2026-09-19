import { createHash } from "node:crypto";

export type ManagedVisibleConfigDrift = "current" | "stale";

type ManagedIdentityDrift = "same_name" | "name_changed";
type ManagedFingerprintDrift = "current" | "stale";
type ManagedPatchState = `${ManagedIdentityDrift}:${ManagedVisibleConfigDrift}:${ManagedFingerprintDrift}`;

export interface ManagedAgentPatch extends Readonly<Record<string, unknown>> {
  readonly name?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ManagedAgentPatchInput {
  readonly observed: {
    readonly name: string;
    readonly managedConfigFingerprint: string | undefined;
  };
  readonly desired: {
    readonly name: string;
    /** Complete adapter-owned state, including values redacted by Paperclip. */
    readonly configuration: unknown;
    /** Full update payload except identity; accidental `name` values are discarded. */
    readonly patch: ManagedAgentPatch;
  };
  /** Comparison of API-visible, non-redacted state only. */
  readonly visibleConfigDrift: ManagedVisibleConfigDrift;
}

export type ManagedAgentPatchDecision =
  | { readonly kind: "unchanged"; readonly desiredFingerprint: string }
  | { readonly kind: "patch"; readonly desiredFingerprint: string; readonly patch: ManagedAgentPatch };

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Managed configuration contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  throw new TypeError(`Managed configuration contains unsupported ${typeof value}`);
}

/**
 * Hashes canonical JSON so hidden values can be reconciled without persisting
 * secrets or trusting Paperclip's redacted API representation.
 */
export function managedConfigFingerprint(configuration: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(configuration))).digest("hex");
}

function requiresPatch(state: ManagedPatchState): boolean {
  switch (state) {
    case "same_name:current:current":
      return false;
    case "same_name:current:stale":
    case "same_name:stale:current":
    case "same_name:stale:stale":
    case "name_changed:current:current":
    case "name_changed:current:stale":
    case "name_changed:stale:current":
    case "name_changed:stale:stale":
      return true;
  }
}

export function decideManagedAgentPatch(input: ManagedAgentPatchInput): ManagedAgentPatchDecision {
  const desiredFingerprint = managedConfigFingerprint(input.desired.configuration);
  const identityDrift: ManagedIdentityDrift =
    input.observed.name === input.desired.name ? "same_name" : "name_changed";
  const fingerprintDrift: ManagedFingerprintDrift =
    input.observed.managedConfigFingerprint === desiredFingerprint ? "current" : "stale";
  const state: ManagedPatchState = `${identityDrift}:${input.visibleConfigDrift}:${fingerprintDrift}`;

  if (!requiresPatch(state)) return { kind: "unchanged", desiredFingerprint };

  const { name: _ignoredIdentity, ...patchWithoutIdentity } = input.desired.patch;
  const patch: ManagedAgentPatch = {
    ...patchWithoutIdentity,
    ...(identityDrift === "name_changed" ? { name: input.desired.name } : {}),
    metadata: {
      ...input.desired.patch.metadata,
      managedConfigFingerprint: desiredFingerprint,
    },
  };
  return { kind: "patch", desiredFingerprint, patch };
}
