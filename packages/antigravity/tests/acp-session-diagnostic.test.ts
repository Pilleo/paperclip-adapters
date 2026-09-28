import { describe, expect, it } from "vitest";
import { diagnoseAcpSessionError } from "../src/server/acp-session-diagnostic.js";

describe("ACP session/new diagnostics", () => {
  it("reports only validation field paths and types without retaining rejected values", () => {
    const diagnostic = diagnoseAcpSessionError({ code: -32602, message: "Invalid params", data: {
      errors: [{ type: "missing", loc: ["mcpServers", 0, "headers", 0, "value"],
        msg: "secret-value was rejected", input: "Bearer secret-value", url: "https://private.invalid" }],
    } });

    expect(diagnostic).toEqual({ code: -32602, fields: ["mcpServers[0].headers[0].value"], types: ["missing"] });
    expect(JSON.stringify(diagnostic)).not.toContain("secret-value");
    expect(JSON.stringify(diagnostic)).not.toContain("private");
  });

  it("rejects unrecognized and nonvalidation error fields", () => {
    expect(diagnoseAcpSessionError(new Error("network failure"))).toBeNull();
    expect(diagnoseAcpSessionError({ code: -32602, data: { errors: [
      { loc: ["apiKey"], type: "secret" },
    ] } })).toEqual({ code: -32602, fields: [], types: [] });
  });
});
