import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { boundNativeReviewWake } from "../src/server/native-review-context.js";

const continuation = { priorRunTranscript: "previous blocked reviewer prose\n".repeat(6000) };
const context = { issueId: "child", executionIdentityRunId: "run", executionContinuation: continuation,
  recoveryIntent: "status_only", allowDeliverableWork: false,
  paperclipTaskMarkdown: "Resolve only the addressed native review card through MCP.",
  paperclipWake: { issue: { id: "child" }, reason: "issue_monitor_due", executionContinuation: continuation } };

describe("bounded native reviewer wake transport", () => {
  it("retains scope and host mutation restrictions while leaving large prior history in the host audit", () => {
    const result = boundNativeReviewWake(context, true);
    expect(result.compacted).toBe(true);
    expect(result.context).toMatchObject({ issueId: "child", executionIdentityRunId: "run",
      recoveryIntent: "status_only", allowDeliverableWork: false, paperclipTaskMarkdown: context.paperclipTaskMarkdown });
    expect(Buffer.byteLength(JSON.stringify(result.context.paperclipWake))).toBeLessThan(48 * 1024);
    expect(context.paperclipWake.executionContinuation).toBe(continuation);
    expect(context.executionContinuation).toBe(continuation);
  });
  it("does not alter ordinary worker context or bounded reviewer wakes", () => {
    expect(boundNativeReviewWake(context, false)).toEqual({ context, compacted: false });
    const small = { issueId: "child", paperclipWake: { issue: { id: "child" } } };
    expect(boundNativeReviewWake(small, true)).toEqual({ context: small, compacted: false });
  });
  it("fails closed on an oversized wake for another issue", () => {
    expect(() => boundNativeReviewWake({ ...context, issueId: "other" }, true)).toThrow("scope");
  });
  it("does not silently drop oversized task content when removing prior history is insufficient", () => {
    expect(() => boundNativeReviewWake({ ...context, paperclipWake: {
      ...context.paperclipWake, issue: { id: "child", description: "x".repeat(150000) },
    } }, true)).toThrow("transport");
  });
  it.runIf(process.platform === "linux")("prevents the actual per-environment-variable E2BIG startup failure", () => {
    const launch = (wake: unknown) => spawnSync(process.execPath, ["-e", "process.stdout.write('started')"], {
      encoding: "utf8", env: { PAPERCLIP_WAKE_PAYLOAD_JSON: JSON.stringify(wake) },
    });
    expect(launch(context.paperclipWake).error).toMatchObject({ code: "E2BIG" });
    const started = launch(boundNativeReviewWake(context, true).context.paperclipWake);
    expect(started.error).toBeUndefined();
    expect(started.status).toBe(0);
    expect(started.stdout).toBe("started");
  });
});
