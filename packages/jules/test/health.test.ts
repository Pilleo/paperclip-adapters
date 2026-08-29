import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkJulesCredentials, checkLocalState } from "../src/server/health.js";
import { JulesClient, JulesClientError } from "../src/server/jules-client.js";

describe("readiness", () => {
  it("probes local storage without leaving a work record", async () => {
    const root = await mkdtemp(join(tmpdir(), "jules-health-"));
    const directory = join(root, "state");
    expect((await checkLocalState(directory)).ok).toBe(true);
    await expect(readFile(join(directory, "session.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses a read-only list call and creates no session", async () => {
    const client = Object.create(JulesClient.prototype) as JulesClient;
    client.listSessions = vi.fn().mockResolvedValue({ sessions: [] });
    client.createSession = vi.fn();
    expect((await checkJulesCredentials(client)).ok).toBe(true);
    expect(client.listSessions).toHaveBeenCalledWith(1);
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("returns actionable invalid-credential guidance", async () => {
    const client = Object.create(JulesClient.prototype) as JulesClient;
    client.listSessions = vi.fn().mockRejectedValue(new JulesClientError(401, "secret"));
    const result = await checkJulesCredentials(client);
    expect(result).toMatchObject({ ok: false, code: "jules_credentials_invalid" });
    expect(result.message).toContain("Rotate JULES_API_KEY");
  });
});
