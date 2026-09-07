import { describe, expect, it } from "vitest";
import {
  extractJulesSessionId,
  extractJulesSessionIdFromComments,
  formatJulesSessionHandleBody,
  parseJulesSessionHandle,
} from "../src/server/jules-session-handle.js";

describe("jules session handle", () => {
  it("extracts the id from a Jules session URL", () => {
    expect(extractJulesSessionId("[Open Jules session](https://jules.google.com/session/2024763132299585220)")).toBe(
      "2024763132299585220",
    );
  });

  it("extracts the id from a document body", () => {
    expect(extractJulesSessionId(formatJulesSessionHandleBody("sess-42", null))).toBe("sess-42");
  });

  it("round-trips an immutable PR identity without breaking the legacy handle", () => {
    const body = formatJulesSessionHandleBody("sess-42", "https://jules.google.com/session/sess-42", {
      prUrl: "https://github.com/Pilleo/paperclip-adapters/pull/5",
      headSha: "ab4a4f2c3fcd498c2c4ca67b8f299225330574d5",
    });
    expect(parseJulesSessionHandle(body)).toEqual({
      sessionId: "sess-42",
      sessionUrl: "https://jules.google.com/session/sess-42",
      prUrl: "https://github.com/Pilleo/paperclip-adapters/pull/5",
      headSha: "ab4a4f2c3fcd498c2c4ca67b8f299225330574d5",
    });
    expect(parseJulesSessionHandle("julesSessionId: legacy\nurl: https://jules.google.com/session/legacy")).toEqual({
      sessionId: "legacy",
      sessionUrl: "https://jules.google.com/session/legacy",
    });
  });

  it("uses the latest matching comment", () => {
    expect(
      extractJulesSessionIdFromComments([
        { body: "[Open Jules session](https://jules.google.com/session/old-1)" },
        { body: "unrelated" },
        { body: "[Open Jules session](https://jules.google.com/session/live-9)" },
      ]),
    ).toBe("live-9");
  });
});
