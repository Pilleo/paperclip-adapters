/**
 * Canonical label resolution for Paperclip tasks.
 */

export interface CanonicalLabel {
  readonly name: string;
  readonly color: string;
}

export const CANONICAL_LABELS: readonly CanonicalLabel[] = Object.freeze([
  { name: "component:enforcer", color: "#e11d48" },
  { name: "component:profiler", color: "#2563eb" },
  { name: "component:orchestrator", color: "#9333ea" },
  { name: "component:docs", color: "#16a34a" },
  { name: "component:ci", color: "#d97706" },
  { name: "component:core", color: "#4f46e5" },
  { name: "priority:critical", color: "#b91c1c" },
  { name: "priority:high", color: "#ea580c" },
  { name: "priority:medium", color: "#ca8a04" },
  { name: "priority:low", color: "#65a30d" },
  { name: "type:bug", color: "#dc2626" },
  { name: "type:feature", color: "#059669" },
  { name: "type:refactor", color: "#7c3aed" },
  { name: "type:review", color: "#0891b2" },
]);

export function resolveIssueLabels(metadata: {
  readonly component?: string | null;
  readonly priority?: string | null;
  readonly severity?: string | null;
  readonly isNonInterfering?: boolean;
  readonly title?: string;
}): readonly CanonicalLabel[] {
  const labels: CanonicalLabel[] = [];

  // Component label
  const comp = (metadata.component || "").toLowerCase().trim();
  if (comp) {
    const compLabel = CANONICAL_LABELS.find((l) => l.name === `component:${comp}`);
    if (compLabel) labels.push(compLabel);
    else labels.push({ name: `component:${comp}`, color: "#64748b" });
  }

  // Priority label
  const prio = (metadata.priority || metadata.severity || "").toLowerCase().trim();
  if (prio === "critical" || prio === "urgent" || prio === "blocker") {
    labels.push(CANONICAL_LABELS.find((l) => l.name === "priority:critical")!);
  } else if (prio === "high" || prio === "p1") {
    labels.push(CANONICAL_LABELS.find((l) => l.name === "priority:high")!);
  } else if (prio === "medium" || prio === "p2" || prio === "normal") {
    labels.push(CANONICAL_LABELS.find((l) => l.name === "priority:medium")!);
  } else if (prio === "low") {
    labels.push(CANONICAL_LABELS.find((l) => l.name === "priority:low")!);
  }

  // Type label based on title / component
  const title = (metadata.title || "").toLowerCase();
  if (metadata.isNonInterfering || title.includes("review")) {
    labels.push(CANONICAL_LABELS.find((l) => l.name === "type:review")!);
  } else if (title.includes("fix") || title.includes("bug") || title.includes("vulnerability") || title.includes("regression")) {
    labels.push(CANONICAL_LABELS.find((l) => l.name === "type:bug")!);
  } else if (title.includes("refactor") || title.includes("clean") || title.includes("purge")) {
    labels.push(CANONICAL_LABELS.find((l) => l.name === "type:refactor")!);
  } else {
    labels.push(CANONICAL_LABELS.find((l) => l.name === "type:feature")!);
  }

  return Object.freeze(labels);
}
