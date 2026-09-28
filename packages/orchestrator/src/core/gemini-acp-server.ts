import { accessSync, constants, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Select an actual ACP server, never the similarly named interactive agy CLI. */
export function resolveGeminiAcpServerPath(input: {
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
} = {}): string | null {
  const env = input.env ?? process.env;
  const explicit = env["ANTIGRAVITY_ACP_SERVER"]?.trim() || env["AGY_ACP_SERVER"]?.trim();
  const verify = (candidate: string): string => {
    if (!path.isAbsolute(candidate) || path.basename(candidate) !== "agy_acp_server.par") {
      throw new Error("Gemini native review requires an absolute AGY ACP server path, not the interactive agy CLI");
    }
    accessSync(candidate, constants.X_OK);
    return candidate;
  };
  if (explicit) return verify(explicit);
  const directory = path.join(input.homeDir ?? os.homedir(),
    ".local/share/zed/external_agents/registry/antigravity-acp");
  let versions: string[];
  try { versions = readdirSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const candidates = versions.flatMap((version) => {
    const candidate = path.join(directory, version, "agy_acp_server.par");
    try { accessSync(candidate, constants.X_OK); return [candidate]; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  });
  if (candidates.length > 1) throw new Error("Ambiguous installed AGY ACP servers; set ANTIGRAVITY_ACP_SERVER explicitly");
  return candidates[0] ?? null;
}
