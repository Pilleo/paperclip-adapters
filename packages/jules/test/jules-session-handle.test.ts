import { describe, expect, it } from "vitest";
import {
  extractJulesSessionId,
  extractJulesSessionIdFromComments,
  formatJulesSessionHandleBody,
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
