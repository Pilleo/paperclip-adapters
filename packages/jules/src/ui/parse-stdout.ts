import type { TranscriptEntry } from "@paperclipai/adapter-utils";

/**
 * Parses stdout from Jules cloud sessions into structured Paperclip UI transcript entries,
 * including collapsible tool executions, thinking blocks, and TDD step accordions.
 */
export function parseJulesStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  // 1. JSON streaming tokens (thoughts / text deltas / tool calls / telemetry)
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type === "thought" && typeof obj.data === "string") {
        return [{ kind: "thinking", ts, text: obj.data, delta: true }];
      }
      if (obj.type === "text" && typeof obj.data === "string") {
        return [{ kind: "assistant", ts, text: obj.data, delta: true }];
      }
      if (obj.type === "tool_call") {
        return [
          {
            kind: "tool_call",
            ts,
            name: obj.name || "tool",
            input: obj.input || { diff: obj.data },
            toolUseId: obj.id || `jules-${Date.now()}`,
          },
        ];
      }
      if (obj.type === "step_progress") {
        return [
          {
            kind: "system",
            ts,
            text: `[Step ${obj.stepNumber || 1}] ${obj.stepName}: ${obj.status || "RUNNING"}`,
          },
        ];
      }
      if (obj.event === "api_request") {
        return [{ kind: "system", ts, text: `API ${obj.method} ${obj.route} (${obj.status})` }];
      }
    } catch {
      // Fall through to plain text handling
    }
  }

  // 2. Structured TDD Lifecycle Accordions
  if (trimmed.startsWith("[jules] 🔬") || trimmed.includes("Codanna Symbol Research")) {
    return [
      {
        kind: "tool_call",
        ts,
        name: "codanna_symbol_research",
        input: { details: trimmed.replace(/^\[jules\]\s*/, "") },
        toolUseId: `codanna-${Date.now()}`,
      },
    ];
  }

  if (trimmed.startsWith("[jules] 🧪") || trimmed.includes("Reproducer Test")) {
    return [
      {
        kind: "tool_call",
        ts,
        name: "tdd_reproducer",
        input: { details: trimmed.replace(/^\[jules\]\s*/, "") },
        toolUseId: `tdd-${Date.now()}`,
      },
    ];
  }

  if (trimmed.startsWith("[jules] 🛡️") || trimmed.includes("Invariant Check")) {
    return [
      {
        kind: "system",
        ts,
        text: trimmed,
      },
    ];
  }

  // 3. Command executions: [jules] $ ... or [jules] Running command: ...
  if (trimmed.startsWith("[jules]") && (trimmed.includes("$ ") || trimmed.includes("Running command:"))) {
    const cmd = trimmed.includes("$ ")
      ? trimmed.slice(trimmed.indexOf("$ ") + 2)
      : trimmed.slice(trimmed.indexOf("Running command:") + 16).trim();
    return [
      {
        kind: "tool_call",
        ts,
        name: "bash",
        input: { command: cmd },
        toolUseId: `jules-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      },
    ];
  }

  // 4. Test execution results / Test summary banners
  if (
    trimmed.startsWith("[jules]") &&
    (trimmed.includes("Tests passed:") ||
      trimmed.includes("Tests failed:") ||
      trimmed.includes("Test summary:") ||
      trimmed.includes("test results:"))
  ) {
    return [
      {
        kind: "tool_result",
        ts,
        toolUseId: `test-${Date.now()}`,
        toolName: "bash",
        content: trimmed,
        isError: trimmed.includes("failed"),
      },
    ];
  }

  // 5. Generated Plan / Progress / Agent messages / Changesets / Status updates
  if (
    trimmed.startsWith("[jules]") &&
    (trimmed.includes("Generated Plan:") ||
      trimmed.includes("Progress:") ||
      trimmed.includes("Agent:") ||
      trimmed.includes("Changeset applied:") ||
      trimmed.includes("Polled session status:") ||
      trimmed.includes("Discovered pull request"))
  ) {
    return [{ kind: "assistant", ts, text: trimmed }];
  }

  // 6. System ticks
  if (trimmed.startsWith("[jules]") || trimmed.startsWith("[paperclip]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  // 7. Default text output -> assistant message
  return [{ kind: "assistant", ts, text: line }];
}
