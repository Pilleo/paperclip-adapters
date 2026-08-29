"use strict";

function parseStdoutLine(line, ts) {
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
            toolUseId: obj.id || "jules-" + Date.now(),
          },
        ];
      }
      if (obj.event === "api_request") {
        return [{ kind: "system", ts, text: "API " + obj.method + " " + obj.route + " (" + obj.status + ")" }];
      }
    } catch {
      // Fall through to plain text handling
    }
  }

  // 2. Command executions: [jules] $ ...
  if (trimmed.startsWith("[jules]") && trimmed.includes("$ ")) {
    const cmd = trimmed.slice(trimmed.indexOf("$ ") + 2);
    return [
      {
        kind: "tool_call",
        ts,
        name: "bash",
        input: { command: cmd },
        toolUseId: "jules-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      },
    ];
  }

  // 3. Generated Plan / Progress / Agent messages / Changesets / Status updates
  if (
    trimmed.startsWith("[jules]") &&
    (trimmed.includes("Generated Plan:") ||
      trimmed.includes("Progress:") ||
      trimmed.includes("Agent:") ||
      trimmed.includes("Changeset applied:") ||
      trimmed.includes("Polled session status: IN_PROGRESS") ||
      trimmed.includes("Discovered pull request"))
  ) {
    return [{ kind: "assistant", ts, text: trimmed }];
  }

  // 4. System ticks
  if (trimmed.startsWith("[jules]") || trimmed.startsWith("[paperclip]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  // 5. Default text output -> assistant message
  return [{ kind: "assistant", ts, text: line }];
}

module.exports = { parseStdoutLine };
