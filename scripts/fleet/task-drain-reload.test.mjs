import assert from "node:assert/strict";
import test from "node:test";
import { drainAndRestart } from "./task-drain-reload.mjs";

function fixture({ existingDrain = false, queued = false, changeEpoch = false, expire = false } = {}) {
  let time = Date.parse("2026-09-30T12:00:00Z"), polls = 0, restarted = false;
  let draining = existingDrain, startedAt = existingDrain ? "2026-09-30T11:00:00Z" : null;
  let expiresAt = "2026-09-30T13:00:00Z";
  const events = [];
  const request = async (method, route) => {
    events.push(`${method} ${route}`);
    if (route === "/api/instance/task-drain") {
      if (method === "POST") { draining = true; startedAt = "2026-09-30T12:00:00Z"; return { startedAt, expiresAt }; }
      if (method === "DELETE") { draining = false; return { wasActive: true }; }
      const activeRuns = draining && ++polls === 1 ? 1 : 0;
      return { draining, startedAt, expiresAt, activeRuns, pendingWakes: 0, quiescent: activeRuns === 0 };
    }
    if (route === "/api/companies") return [{ id: "company-a" }, { id: "company-b" }];
    if (route.includes("/live-runs?minCount=0&limit=50")) {
      if (changeEpoch) startedAt = "2026-09-30T12:01:00Z";
      if (expire) { draining = false; expiresAt = "2026-09-30T11:00:00Z"; }
      return queued ? [{ id: "old-queued-run", status: "queued" }] : [];
    }
    throw Error(`Unexpected request ${method} ${route}`);
  };
  return { events, request, now: () => time, sleep: async () => { time += 10; },
    restart: async () => { assert.equal(draining, true, "admission must remain held through restart");
      events.push("restart"); restarted = true; draining = false; },
    restarted: () => restarted, draining: () => draining };
}

test("establishes native admission hold before quiescence reads and keeps it until restart", async () => {
  const f = fixture();
  await drainAndRestart({ ...f, waitMs: 100, pollMs: 10 });
  assert.equal(f.restarted(), true);
  assert.ok(f.events.indexOf("POST /api/instance/task-drain") < f.events.indexOf("GET /api/companies"));
  assert.ok(f.events.includes("GET /api/companies/company-b/live-runs?minCount=0&limit=50"));
  assert.equal(f.events.some((event) => event.startsWith("DELETE")), false, "do not release admission before restart");
});

test("refuses a queued database run even when in-process drain counters are quiescent", async () => {
  const f = fixture({ queued: true });
  await assert.rejects(drainAndRestart({ ...f, waitMs: 100, pollMs: 10 }), /live runs/);
  assert.equal(f.restarted(), false);
  assert.equal(f.draining(), false, "release only our own drain on pre-restart failure");
});

test("never takes over or releases an existing operator drain", async () => {
  const f = fixture({ existingDrain: true });
  await assert.rejects(drainAndRestart({ ...f, waitMs: 100, pollMs: 10 }), /already draining/);
  assert.equal(f.events.some((event) => event.startsWith("POST") || event.startsWith("DELETE")), false);
});

test("does not restart or clear another drain when the owned epoch changed", async () => {
  const f = fixture({ changeEpoch: true });
  await assert.rejects(drainAndRestart({ ...f, waitMs: 100, pollMs: 10 }), /ownership changed/);
  assert.equal(f.restarted(), false);
  assert.equal(f.events.some((event) => event.startsWith("DELETE")), false);
});

test("does not restart after the drain expires between database check and restart", async () => {
  const f = fixture({ expire: true });
  await assert.rejects(drainAndRestart({ ...f, waitMs: 100, pollMs: 10 }), /expired|not active/);
  assert.equal(f.restarted(), false);
});

test("retains admission hold when restart acknowledgement is lost", async () => {
  const f = fixture();
  await assert.rejects(drainAndRestart({ ...f, waitMs: 100, pollMs: 10,
    restart: async () => { throw new Error("Restart response lost; outcome unknown"); },
  }), /outcome unknown/);
  assert.equal(f.draining(), true);
  assert.equal(f.events.some((event) => event.startsWith("DELETE")), false);
});

test("does not act on a drain-start receipt with an invalid expiry", async () => {
  const f = fixture();
  await assert.rejects(drainAndRestart({ ...f, waitMs: 100, pollMs: 10,
    request: async (method, route, body) => {
      const result = await f.request(method, route, body);
      return method === "POST" ? { ...result, expiresAt: "not-a-date" } : result;
    },
  }), /receipt is unverified/);
  assert.equal(f.restarted(), false);
});
