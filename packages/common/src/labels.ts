export const CANONICAL_COMPONENTS = [
  "enforcer",
  "profiler",
  "core",
  "tools",
  "ci",
  "docs",
  "orchestrator",
  "build",
] as const;

export type CanonicalComponent = (typeof CANONICAL_COMPONENTS)[number];

export const CANONICAL_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type CanonicalPriority = (typeof CANONICAL_PRIORITIES)[number];

export function toComponentLabel(component: string): string {
  const normalized = component.trim().toLowerCase();
  return `component:${normalized}`;
}

export function parseComponentFromLabel(label: string): string | undefined {
  const match = label.match(/^component:(.+)$/i);
  return match?.[1]?.trim().toLowerCase();
}

export function toPriorityLabel(priority: string): string {
  const normalized = priority.trim().toLowerCase();
  return `priority:${normalized}`;
}

export function parsePriorityFromLabel(label: string): CanonicalPriority | undefined {
  const match = label.match(/^priority:(.+)$/i);
  const p = match?.[1]?.trim().toLowerCase();
  if (p && (CANONICAL_PRIORITIES as readonly string[]).includes(p)) {
    return p as CanonicalPriority;
  }
  return undefined;
}
