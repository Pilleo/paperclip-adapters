export interface ProjectCapacity {
  readonly projectId: string;
  readonly jules: number;
  readonly vibe: number;
}

/**
 * Split company-wide worker capacity between project ticks. The allocation is
 * deterministic and never exceeds either global limit when project runs are
 * executed sequentially.
 */
export function allocateProjectCapacity(params: {
  readonly projectIds: readonly string[];
  readonly maxConcurrentJules: number;
  readonly maxConcurrentVibe: number;
}): readonly ProjectCapacity[] {
  const ids = [...new Set(params.projectIds)];
  if (ids.length === 0) return Object.freeze([]);
  const allocate = (total: number, index: number) => Math.max(0, Math.floor((Math.max(0, total) + index) / ids.length));
  return Object.freeze(ids.map((projectId, index) => Object.freeze({
    projectId,
    jules: allocate(params.maxConcurrentJules, index),
    vibe: allocate(params.maxConcurrentVibe, index),
  })));
}
