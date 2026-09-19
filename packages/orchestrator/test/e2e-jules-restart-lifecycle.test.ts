import { afterEach, describe, expect, it } from "vitest";
import { JulesClient } from "../../jules/src/server/jules-client.js";
import {
  startScriptedJulesServer,
  type ScriptedJulesServer,
} from "./fixtures/scripted-jules-server.js";

describe("Jules restart lifecycle provider boundary", () => {
  let server: ScriptedJulesServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("records one real provider verdict delivery across an interrupted observation", async () => {
    // Break protected by this test: changing the provider client boundary so a
    // restart/re-observation replays an already delivered verdict.
    server = await startScriptedJulesServer([
      {
        method: "POST",
        pathname: "/v1alpha/sessions/session-1:sendMessage",
        response: { status: 200, body: { id: "activity-verdict-1" } },
      },
      {
        method: "GET",
        pathname: "/v1alpha/sessions/session-1",
        response: { status: 200, body: { name: "sessions/session-1", state: "AWAITING_USER_FEEDBACK" } },
      },
    ]);
    const client = new JulesClient("test-key", undefined, server.baseUrl);

    await client.sendMessage("session-1" as never, { prompt: "Reject revision rev-1." });
    const observed = await client.getSession("session-1" as never);

    expect(observed.state).toBe("AWAITING_USER_FEEDBACK");
    expect(server.requests()).toEqual([
      {
        method: "POST",
        pathname: "/v1alpha/sessions/session-1:sendMessage",
        body: { prompt: "Reject revision rev-1." },
      },
      { method: "GET", pathname: "/v1alpha/sessions/session-1", body: undefined },
    ]);
    expect(server.remainingSteps()).toEqual([]);
  });
});
