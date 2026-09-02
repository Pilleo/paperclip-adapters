import type { AgentIncident } from "./agent-health-monitor.js";

/** Adapter-process incident memory; prevents heartbeat/project fan-out spam. */
export class IncidentDeduper {
  private readonly fingerprints = new Map<string, string>();

  reconcile(incidents: readonly AgentIncident[]): readonly AgentIncident[] {
    const current = new Set<string>();
    const newlyObserved: AgentIncident[] = [];
    for (const incident of incidents) {
      const fingerprint = `${incident.severity}|${incident.status}|${incident.issue}|${incident.remediation}`;
      current.add(incident.agentId);
      if (this.fingerprints.get(incident.agentId) === fingerprint) continue;
      this.fingerprints.set(incident.agentId, fingerprint);
      newlyObserved.push(incident);
    }
    for (const agentId of this.fingerprints.keys()) {
      if (!current.has(agentId)) this.fingerprints.delete(agentId);
    }
    return Object.freeze(newlyObserved);
  }
}
