"use strict";

function parseStdoutLine(line, ts) {
  const trimmed = line.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed);
      const type = obj.type || "";

      // ACPX streaming text / thought deltas
      if (type === "acpx.text_delta" || type === "text_delta" || type === "thought" || type === "text") {
        const text = typeof obj.text === "string" ? obj.text : typeof obj.data === "string" ? obj.data : "";
        if (obj.channel === "thought" || type === "thought") {
          return [{ kind: "thinking", ts, text, delta: true }];
        }
        return [{ kind: "assistant", ts, text, delta: true }];
      }

      // ACPX tool calls
      if (type === "acpx.tool_call" || type === "tool_call") {
        return [
          {
            kind: "tool_call",
            ts,
            name: obj.name || "tool",
            input: obj.input || { text: obj.text },
            toolUseId: obj.toolCallId || obj.toolUseId,
          },
        ];
      }

      // ACPX tool result
      if (type === "acpx.tool_result" || type === "tool_result") {
        return [
          {
            kind: "tool_result",
            ts,
            toolUseId: obj.toolCallId || obj.toolUseId || "tool_call",
            content: typeof obj.content === "string" ? obj.content : JSON.stringify(obj.content || obj.result || ""),
            isError: Boolean(obj.isError || obj.status === "error" || obj.status === "failed"),
          },
        ];
      }

      // ACPX status / system
      if (type === "acpx.status" || type === "system" || obj.event === "api_request") {
        return [{ kind: "system", ts, text: obj.text || `system: ${type}` }];
      }
    } catch {
      // Fall through
    }
  }

  // CLI prefix lines
  if (trimmed.startsWith("[antigravity]") || trimmed.startsWith("[paperclip]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  return [{ kind: "assistant", ts, text: line }];
}

module.exports = { parseStdoutLine };
