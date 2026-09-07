/**
 * Small, dependency-free compatibility model shared by the adapters.
 *
 * Paperclip evolves faster than independently released adapters. Keeping the
 * probe result typed and tri-state prevents an ambiguous host response from
 * being mistaken for permission to perform a newer mutation.
 */

export type CapabilityStatus = "supported" | "unsupported" | "unknown";

export type PaperclipCapability =
  | "continuationWakeup"
  | "activityCursor"
  | "pluginState";

export type CapabilitySnapshot = {
  readonly hostVersion?: string;
  readonly capabilities: Readonly<Record<PaperclipCapability, CapabilityStatus>>;
};

export type CapabilityProbeResponse = {
  readonly version?: unknown;
  readonly capabilities?: unknown;
};

const CAPABILITIES: readonly PaperclipCapability[] = [
  "continuationWakeup",
  "activityCursor",
  "pluginState",
];

function status(value: unknown): CapabilityStatus {
  if (value === true || value === "supported") return "supported";
  if (value === false || value === "unsupported") return "unsupported";
  return "unknown";
}

/** Convert an untrusted host response into a complete immutable snapshot. */
export function createCapabilitySnapshot(raw: CapabilityProbeResponse | unknown): CapabilitySnapshot {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const rawCapabilities = record["capabilities"];
  const capabilities = rawCapabilities && typeof rawCapabilities === "object"
    ? rawCapabilities as Record<string, unknown>
    : {};
  const normalized = Object.fromEntries(
    CAPABILITIES.map((capability) => [capability, status(capabilities[capability])]),
  ) as Record<PaperclipCapability, CapabilityStatus>;
  const hostVersion = typeof record["version"] === "string" && record["version"].trim()
    ? record["version"].trim()
    : undefined;
  return { ...(hostVersion ? { hostVersion } : {}), capabilities: normalized };
}

/**
 * Select the safe execution path for a capability.
 *
 * Continuation/activity features have a safe legacy implementation. State
 * mutations do not: without positive support, callers must not pretend that
 * a host-side compare-and-set operation exists.
 */
export function decideMutationMode(
  snapshot: CapabilitySnapshot,
  capability: PaperclipCapability,
): "native" | "legacy" | "reject" {
  const state = snapshot.capabilities[capability];
  if (state === "supported") return "native";
  if (capability === "pluginState") return "reject";
  return "legacy";
}
