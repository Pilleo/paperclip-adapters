import { describe, expect, it } from "vitest";
import { IncidentDeduper } from "../src/core/incident-deduper.js";
import type { AgentIncident } from "../src/core/agent-health-monitor.js";

const incident: AgentIncident = {
  agentId: "luna",
  agentName: "Luna",
  severity: "CRITICAL",
  status: "error",
  issue: "Process lost",
  remediation: "Restart",
};

describe("IncidentDeduper", () => {
  it("reports a failure once and suppresses identical heartbeat/project repeats", () => {
    const deduper = new IncidentDeduper();
    expect(deduper.reconcile([incident])).toEqual([incident]);
    expect(deduper.reconcile([incident])).toEqual([]);
    expect(deduper.reconcile([incident, incident])).toEqual([]);
  });

  it("reports changed failures and regressions after recovery", () => {
    const deduper = new IncidentDeduper();
    expect(deduper.reconcile([incident])).toHaveLength(1);
    expect(deduper.reconcile([])).toEqual([]);
    expect(deduper.reconcile([incident])).toEqual([incident]);
    expect(deduper.reconcile([{ ...incident, issue: "401 unauthorized" }])).toHaveLength(1);
  });
});
