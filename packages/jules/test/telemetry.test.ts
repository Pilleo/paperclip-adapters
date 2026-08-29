import { describe, expect, it, vi } from "vitest";
import { createTelemetry, redactTelemetry } from "../src/server/telemetry.js";

describe("Jules telemetry", () => {
  it("always includes issue/session correlation fields", async () => {
    const sink = vi.fn();
    await createTelemetry("JUL-14", sink)("poll", "session-7", { pages: 2, checkpointLagMs: 50 });
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({
      event: "poll", paperclipIssueId: "JUL-14", julesSessionId: "session-7", pages: 2,
    }));
  });

  it("recursively redacts credentials, tokens, and prompts", () => {
    expect(redactTelemetry({
      apiKey: "AIza-secret", nested: { authorization: "Bearer secret", prompt: "private code" }, safe: "ok",
    })).toEqual({
      apiKey: "[REDACTED]", nested: { authorization: "[REDACTED]", prompt: "[REDACTED]" }, safe: "ok",
    });
  });
});
