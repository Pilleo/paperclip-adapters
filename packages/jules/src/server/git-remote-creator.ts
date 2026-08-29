import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export function isGhCliAuthenticated(cwd?: string): boolean {
  try {
    execSync("gh auth status", {
      cwd: cwd || process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

export function getDefaultRepoName(cwd?: string): string {
  const dir = cwd ? path.resolve(cwd) : process.cwd();
  return path.basename(dir).replace(/[^a-zA-Z0-9._-]/g, "-");
}

export interface CreateRemoteRepoOptions {
  cwd?: string;
  repoName?: string;
  isPrivate?: boolean;
  defaultBranch?: string;
}

export interface CreateRemoteRepoResult {
  success: boolean;
  repository?: string;
  repoUrl?: string;
  error?: string;
  hint?: string;
}

export function createRemoteGitHubRepo(options: CreateRemoteRepoOptions = {}): CreateRemoteRepoResult {
  const targetCwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const repoName = options.repoName || getDefaultRepoName(targetCwd);
  const visibilityFlag = options.isPrivate !== false ? "--private" : "--public";

  try {
    // 1. Ensure git is initialized in the workspace
    if (!fs.existsSync(path.join(targetCwd, ".git"))) {
      execSync("git init", { cwd: targetCwd, stdio: "ignore", timeout: 5000 });
    }

    // 2. Run gh repo create with source, remote=origin, and push
    const output = execSync(
      `gh repo create ${JSON.stringify(repoName)} ${visibilityFlag} --source=. --remote=origin --push`,
      {
        cwd: targetCwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
      }
    ).trim();

    // 3. Query the created origin remote URL
    const remoteUrl = execSync("git config --get remote.origin.url", {
      cwd: targetCwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();

    const match = remoteUrl.match(/(?:github\.com[/:]|^)([^/\s]+)\/([^/#\s]+?)(?:\.git)?$/i);
    const repository = match ? `${match[1]}/${match[2]}` : repoName;

    return {
      success: true,
      repository,
      repoUrl: remoteUrl,
      hint: "Ensure the Google Jules GitHub App (https://github.com/apps/google-jules) has access to this repository in your GitHub account.",
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Failed to create GitHub repository via gh CLI: ${errorMsg}`,
      hint: "Make sure you are logged into GitHub CLI (`gh auth login`) and have repository creation permissions.",
    };
  }
}
