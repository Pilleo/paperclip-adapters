import { describe, it, expect } from "vitest";
import { parseJulesStdoutLine } from "../src/ui/parse-stdout";

describe("UI Parse Stdout", () => {
  it("maps JSON streaming thought tokens to thinking transcript entries", () => {
    const res = parseJulesStdoutLine('{"type":"thought","data":"planning steps"}', "2026-08-27T10:00:00Z");
    expect(res).toEqual([
      { kind: "thinking", ts: "2026-08-27T10:00:00Z", text: "planning steps", delta: true },
    ]);
  });

  it("maps JSON streaming text tokens to assistant transcript entries", () => {
    const res = parseJulesStdoutLine('{"type":"text","data":"I will fix this."}', "2026-08-27T10:00:00Z");
    expect(res).toEqual([
      { kind: "assistant", ts: "2026-08-27T10:00:00Z", text: "I will fix this.", delta: true },
    ]);
  });

  it("maps bash commands to tool_call entries", () => {
    const res = parseJulesStdoutLine("[jules][15:00:00] $ ./gradlew test", "2026-08-27T10:00:00Z");
    expect(res).toHaveLength(1);
    expect(res[0].kind).toBe("tool_call");
    expect((res[0] as any).name).toBe("bash");
    expect((res[0] as any).input).toEqual({ command: "./gradlew test" });
  });

  it("maps plain lines to assistant entries", () => {
    const res = parseJulesStdoutLine("Hello from Jules", "2026-08-27T10:00:00Z");
    expect(res).toEqual([
      { kind: "assistant", ts: "2026-08-27T10:00:00Z", text: "Hello from Jules" },
    ]);
  });
});
