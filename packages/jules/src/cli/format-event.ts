import pc from "picocolors";

export function formatStdoutEvent(line: string, debug = false): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type === "thought" && typeof obj.data === "string") {
        console.log(pc.gray(`[Jules Thinking] ${obj.data}`));
        return;
      }
      if (obj.type === "text" && typeof obj.data === "string") {
        console.log(pc.green(`[Jules] ${obj.data}`));
        return;
      }
      if (obj.event === "api_request") {
        if (debug) console.log(pc.dim(`[Jules API] ${obj.method} ${obj.route} (${obj.status})`));
        return;
      }
    } catch {
      // Non-JSON
    }
  }

  if (trimmed.startsWith("[jules]") && trimmed.includes("$ ")) {
    console.log(pc.yellow(trimmed));
    return;
  }

  if (trimmed.startsWith("[jules]") && trimmed.includes("Generated Plan:")) {
    console.log(pc.cyan(trimmed));
    return;
  }

  if (trimmed.startsWith("[jules]")) {
    console.log(pc.blue(trimmed));
    return;
  }

  if (debug) {
    console.log(pc.dim(trimmed));
  } else {
    console.log(trimmed);
  }
}

export function formatEvent(event: unknown) {
  if (typeof event === "object" && event !== null) {
    const e = event as Record<string, unknown>;
    if (typeof e["type"] === "string" && e["type"].startsWith("jules.")) {
      return `[Jules] ${e["type"]}: Session ${e["julesSessionId"] || "unknown"}`;
    }
  }
  return null;
}
