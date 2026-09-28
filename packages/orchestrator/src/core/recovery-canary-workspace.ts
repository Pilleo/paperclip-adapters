/** A disposable checkout's project metadata must identify the repository it actually tests. */
export function buildRecoveryCanaryWorkspace(cwd: string, defaultRef: string) {
  return {
    name: "Canary local workspace",
    sourceType: "local_path" as const,
    cwd,
    repoUrl: "https://github.com/pilleo/paperclip-adapters.git",
    defaultRef,
    isPrimary: true,
  };
}
