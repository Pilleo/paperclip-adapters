/**
 * Git hook processes export GIT_* bindings for the repository being hooked.
 * Commands targeting an explicit workspace must not inherit those bindings,
 * or Git can operate on the caller's index/configuration instead of `cwd`.
 */
export function isolatedGitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !name.startsWith("GIT_")),
  );
}
