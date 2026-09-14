export interface JulesAdmissionAllocation {
  readonly projectId: string;
  readonly newSessionBudget: number;
}

export function julesAdmissionRotationOffset(heartbeatId: string | undefined, projectCount: number): number {
  if (projectCount <= 0) return 0;
  let hash = 0;
  for (const character of heartbeatId ?? "") {
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  }
  return hash % projectCount;
}

/**
 * Divides a company heartbeat's bounded number of new Jules session starts
 * between projects. This is deliberately independent of provider sessions:
 * once a session exists, Jules owns its queue and concurrency.
 */
export function allocateCompanyJulesAdmissions(input: {
  readonly projectIds: readonly string[];
  readonly maxNewSessions: number;
  readonly rotationOffset: number;
}): readonly JulesAdmissionAllocation[] {
  const projectIds = [...new Set(input.projectIds)];
  const count = projectIds.length;
  if (count === 0) return Object.freeze([]);

  const budget = Math.max(0, Math.floor(input.maxNewSessions));
  const offset = ((Math.floor(input.rotationOffset) % count) + count) % count;
  const rotated = projectIds.map((_, index) => projectIds[(index + offset) % count] as string);
  const base = Math.floor(budget / count);
  let remainder = budget % count;
  const byProjectId = new Map<string, number>();

  for (const projectId of rotated) {
    const allocation = base + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    byProjectId.set(projectId, allocation);
  }

  return Object.freeze(projectIds.map((projectId) => Object.freeze({
    projectId,
    newSessionBudget: byProjectId.get(projectId) ?? 0,
  })));
}
