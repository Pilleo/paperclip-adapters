import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { parseAcpxStdoutLine } from "@paperclipai/adapter-utils/acpx-engine/ui";

export function parseAntigravityStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type?.startsWith("acpx.")) {
        return parseAcpxStdoutLine(line, ts);
      }
      if (obj.type === "thought" && typeof obj.data === "string") {
        return [{ kind: "thinking", ts, text: obj.data, delta: true }];
      }
      if (obj.type === "text" && typeof obj.data === "string") {
        return [{ kind: "assistant", ts, text: obj.data, delta: true }];
      }
    } catch {
      // Fall through
    }
  }

  if (trimmed.startsWith("[antigravity]") || trimmed.startsWith("[paperclip]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  return [{ kind: "assistant", ts, text: line }];
}
