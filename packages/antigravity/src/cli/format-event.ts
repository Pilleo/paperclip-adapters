import { printAcpxStreamEvent } from "@paperclipai/adapter-utils/acpx-engine/cli";
import pc from "picocolors";

export function formatAntigravityStdoutEvent(raw: string, debug = false): void {
  const line = raw.trim();
  if (!line) return;

  if (line.startsWith("{") && line.endsWith("}")) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type?.startsWith("acpx.")) {
        printAcpxStreamEvent(raw, debug);
        return;
      }
      if (parsed.method) {
        console.log(pc.cyan("[AGY ACP] ") + pc.yellow(parsed.method));
        return;
      }
    } catch {
      // Non-JSON
    }
  }

  if (debug) {
    console.log(pc.dim("[AGY] ") + line);
  } else {
    console.log(line);
  }
}
