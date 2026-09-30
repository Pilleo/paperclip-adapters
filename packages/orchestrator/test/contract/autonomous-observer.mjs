/** Test driver: setup ends before source creation; subsequent control-plane access is GET-only. */
export function createAutonomousObserver(baseUrl) {
  let phase = "setup";
  const trace = [];
  const request = async (method, route, body, requestPhase = phase) => {
    trace.push({ phase: requestPhase, method, route });
    const response = await fetch(`${baseUrl}/api${route}`, { method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`${method} ${route} (${response.status}): ${await response.text()}`);
    return response.json();
  };
  const requireSetup = () => {
    if (phase !== "setup") throw new Error("Autonomous observation is read-only after source start");
  };
  return {
    get trace() { return structuredClone(trace); },
    beginObservation() { requireSetup(); phase = "observing"; },
    async setup(route, body) {
      requireSetup();
      return request("POST", route, body);
    },
    async startIssue(route, body) {
      requireSetup();
      if (!/^\/companies\/[^/]+\/issues$/.test(route)) throw new Error("Start must create the source issue");
      // Seal before fetch: even an ambiguous/failed POST cannot authorize rescue writes.
      phase = "observing";
      return request("POST", route, body, "start");
    },
    get(route) { return request("GET", route); },
  };
}
