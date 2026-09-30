export async function drainAndRestart({ request, restart, waitMs = 900_000, pollMs = 1000,
  now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  record = async () => {} }) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 3_600_000 ||
      !Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error("Invalid reload wait budget");
  const prior = await request("GET", "/api/instance/task-drain");
  if (typeof prior?.draining !== "boolean") throw new Error("Invalid task-drain status");
  if (prior.draining) throw new Error("Instance is already draining; refusing to take over");
  const ttlMs = waitMs + 120_000;
  await record({ event: "drain_start_intent", ttlMs });
  const created = await request("POST", "/api/instance/task-drain", { ttlMs });
  if (typeof created?.startedAt !== "string" || !Number.isFinite(Date.parse(created.startedAt)) ||
      typeof created.expiresAt !== "string" || !Number.isFinite(Date.parse(created.expiresAt)) || Date.parse(created.expiresAt) <= now()) {
    throw new Error("Task-drain start receipt is unverified; do not repeat the POST");
  }
  const epoch = created.startedAt;
  let restartAttempted = false;
  await record({ event: "drain_started", epoch, expiresAt: created.expiresAt });
  const checkedStatus = async () => {
    const status = await request("GET", "/api/instance/task-drain");
    if (status.draining !== true) throw new Error("Owned task drain is not active or expired");
    if (status.startedAt !== epoch) throw new Error("Task-drain ownership changed");
    if (typeof status.expiresAt !== "string" || !Number.isFinite(Date.parse(status.expiresAt)) ||
        Date.parse(status.expiresAt) <= now() + 30_000) throw new Error("Task drain expired or has insufficient restart margin");
    if (!Number.isSafeInteger(status.activeRuns) || status.activeRuns < 0 ||
        !Number.isSafeInteger(status.pendingWakes) || status.pendingWakes < 0 ||
        status.quiescent !== (status.activeRuns === 0 && status.pendingWakes === 0)) {
      throw new Error("Task-drain quiescence counters are inconsistent");
    }
    return status;
  };
  try {
    const deadline = now() + waitMs;
    while (!(await checkedStatus()).quiescent) {
      if (now() >= deadline) throw new Error("Task-drain quiescence wait expired");
      await sleep(pollMs);
    }
    const companies = await request("GET", "/api/companies");
    if (!Array.isArray(companies) || !companies.length || companies.some((company) =>
      typeof company.id !== "string" || !company.id) || new Set(companies.map((company) => company.id)).size !== companies.length) {
      throw new Error("Company scope read is incomplete");
    }
    for (const company of companies) {
      const runs = await request("GET", `/api/companies/${encodeURIComponent(company.id)}/live-runs?minCount=0&limit=50`);
      if (!Array.isArray(runs) || runs.length >= 50) throw new Error("Authoritative live runs read is incomplete");
      if (runs.length) throw new Error(`Company ${company.id} retains live runs; refusing restart`);
    }
    if (!(await checkedStatus()).quiescent) throw new Error("Execution resumed before restart; refusing restart");
    await record({ event: "restart_intent", epoch, companies: companies.map((company) => company.id) });
    // Never DELETE the admission hold before this call. The old process stays
    // drained through its stop; the replacement process resets drain state.
    restartAttempted = true;
    await restart();
    await record({ event: "restart_acknowledged", epoch });
    return { epoch, companyIds: companies.map((company) => company.id) };
  } catch (error) {
    if (restartAttempted) {
      await record({ event: "restart_outcome_unverified", epoch });
      throw error;
    }
    try {
      const current = await request("GET", "/api/instance/task-drain");
      if (current.draining === true && current.startedAt === epoch) {
        await record({ event: "owned_drain_release_intent", epoch });
        await request("DELETE", "/api/instance/task-drain");
        await record({ event: "owned_drain_released", epoch });
      } else {
        await record({ event: "drain_cleanup_not_owned", epoch });
      }
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Reload failed and owned-drain cleanup could not be verified");
    }
    throw error;
  }
}

export async function reloadAndVerify(input) {
  const result = await drainAndRestart(input);
  await input.waitReady?.();
  const reset = await input.request("GET", "/api/instance/task-drain");
  if (reset.draining !== false || reset.startedAt !== null) {
    throw new Error("Task-drain state did not reset after process replacement; reload is not verified");
  }
  await input.verifyLoaded();
  const reconciliation = await input.waitReconciled();
  if (!reconciliation || typeof reconciliation.runId !== "string" || !reconciliation.runId) {
    throw new Error("Post-reload reconciliation is not verified");
  }
  await input.record?.({ event: "reload_verified", epoch: result.epoch, reconciliationRunId: reconciliation.runId });
  return { ...result, reconciliation };
}
