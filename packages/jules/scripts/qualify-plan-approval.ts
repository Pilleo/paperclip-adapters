import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JulesClient, type CreateSessionRequest } from "../src/server/jules-client.js";
import { createProviderCreateEvidence } from "../src/server/provider-request-evidence.js";
import { decideProviderCreateRecovery } from "../src/server/provider-create-reconciliation.js";
import { buildPrompt } from "../src/server/prompt-builder.js";
import { validateConfig } from "../src/server/config.js";
import { buildCanaryA } from "../../orchestrator/src/core/real-e2e-canary-fixture.js";

interface QualificationClient {
  createSession(request: CreateSessionRequest, requestId?: string): Promise<{ id: string }>;
  listSessions(pageSize: number, pageToken?: string): Promise<{ sessions: Array<{ id: string; prompt?: string; source?: string; baseBranch?: string; createTime?: string }>; nextPageToken?: string | undefined }>;
  getSession(sessionId: never): Promise<{ state?: string; updateTime?: string; outputs?: unknown[] }>;
  getActivities(sessionId: never, pageToken?: string, pageSize?: number): Promise<{ activities: Array<Record<string, unknown>>; nextPageToken?: string | undefined }>;
}

type Evidence = ReturnType<typeof createProviderCreateEvidence>;
type Observation = { readonly state: string; readonly updatedAt: string | null; readonly outputCount: number;
  readonly activities: readonly { readonly kind: string; readonly createdAt: string | null }[]; readonly observedAt: string };
type Manifest = { version: 1; intent: Evidence; sessionId?: string; observations: Observation[] };

async function saveManifest(destination: string, manifest: Manifest): Promise<void> {
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
  await rename(temporary, destination);
}

async function readManifest(destination: string): Promise<Manifest | null> {
  try {
    const info = await stat(destination);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw Error("Qualification manifest must be owner-only");
    const value = JSON.parse(await readFile(destination, "utf8")) as Manifest;
    if (value.version !== 1 || !value.intent || !Array.isArray(value.observations)) throw Error("Invalid qualification manifest");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** One read/creation step. An existing intent is never replayed. */
export async function qualifyPlanApprovalStep(input: { client: QualificationClient; manifestPath: string;
  request: CreateSessionRequest; createAllowed: boolean }): Promise<Manifest> {
  const { client, manifestPath, request } = input;
  let manifest = await readManifest(manifestPath);
  if (!manifest) {
    if (!input.createAllowed) throw Error("No qualified provider session; use --create deliberately");
    if (request.requirePlanApproval !== true) throw Error("Approval qualification requires plan approval");
    const intent = createProviderCreateEvidence(request, { issueId: "qualification-control", runId: "qualification-control" });
    manifest = { version: 1, intent, observations: [] };
    await saveManifest(manifestPath, manifest);
    let created: { id: string };
    try { created = await client.createSession(request, intent.requestId); }
    catch { throw Error("Provider create outcome unknown; retain manifest and observe before any further action"); }
    manifest.sessionId = created.id;
    await saveManifest(manifestPath, manifest);
  }
  if (!manifest.sessionId) {
    const candidates: Array<{ id: string; promptSha256: string; source: string; baseBranch: string; createdAt?: string | undefined }> = [];
    let token: string | undefined;
    let complete = false;
    const seen = new Set<string>();
    for (let index = 0; index < 20; index++) {
      const page = await client.listSessions(100, token);
      for (const session of page.sessions) {
        if (!session.prompt) continue;
        candidates.push({ id: session.id, promptSha256: createHash("sha256").update(session.prompt).digest("hex"),
          source: session.source ?? "", baseBranch: session.baseBranch ?? "", createdAt: session.createTime });
      }
      token = page.nextPageToken;
      if (!token) { complete = true; break; }
      if (seen.has(token)) break;
      seen.add(token);
    }
    const outcome = decideProviderCreateRecovery(manifest.intent, candidates, complete);
    if (outcome.kind !== "reattach") throw Error(`Provider create not uniquely identified (${outcome.reason}); no new POST allowed`);
    manifest.sessionId = outcome.sessionId;
    await saveManifest(manifestPath, manifest);
  }
  const sessionId = manifest.sessionId as never;
  const session = await client.getSession(sessionId);
  const activities: Observation["activities"][number][] = [];
  let token: string | undefined;
  const seen = new Set<string>();
  let complete = false;
  for (let index = 0; index < 20; index++) {
    const page = await client.getActivities(sessionId, token, 100);
    for (const activity of page.activities) {
      const kind = ["planGenerated", "planApproved", "userMessaged", "agentMessaged", "progressUpdated", "sessionCompleted", "sessionFailed"]
        .find((entry) => Object.hasOwn(activity, entry)) ?? "other";
      activities.push({ kind, createdAt: typeof activity["createTime"] === "string" ? activity["createTime"] : null });
    }
    token = page.nextPageToken;
    if (!token) { complete = true; break; }
    if (seen.has(token)) break;
    seen.add(token);
  }
  if (!complete) throw Error("Provider activity history incomplete; no completion inference allowed");
  manifest.observations.push({ state: session.state ?? "STATE_UNSPECIFIED", updatedAt: session.updateTime ?? null,
    outputCount: session.outputs?.length ?? 0, activities, observedAt: new Date().toISOString() });
  await saveManifest(manifestPath, manifest);
  return manifest;
}

export async function loadKey(): Promise<string> {
  const envFile = fileURLToPath(new URL("../../../.ENV", import.meta.url));
  const handle = await open(envFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw Error(".ENV must be owner-only");
    const content = await handle.readFile("utf8");
    const values = [...content.matchAll(/^\s*(?:export\s+)?JULES_API_KEY\s*=\s*(.*?)\s*$/gm)];
    if (values.length !== 1) throw Error("Exactly one Jules credential is required");
    const key = values[0]![1]!.replace(/^['"]|['"]$/g, "");
    if (!key || /\s/.test(key)) throw Error("Jules credential is invalid");
    return key;
  } finally { await handle.close(); }
}

async function main(): Promise<void> {
  const createAllowed = process.argv.includes("--create");
  const noAutoPr = process.argv.includes("--no-auto-pr");
  const manifestPath = path.join(tmpdir(), noAutoPr
    ? "paperclip-jules-approval-qualification-no-auto.json"
    : "paperclip-jules-approval-qualification.json");
  const manifest = await readManifest(manifestPath);
  const key = await loadKey();
  const client = new JulesClient(key);
  const runKey = manifest?.intent.runId ?? `qual-${noAutoPr ? "no-auto-" : ""}${Date.now()}-${process.pid}`;
  const issue = buildCanaryA("d53718c7-90c3-462b-b8bb-4ff7d54fa37e", runKey);
  const config = validateConfig({ repository: "Pilleo/paperclip-adapters-e2e-20260923-vanilla-review", baseBranch: "master",
    planApprovalPolicy: "required", prPolicy: noAutoPr ? "never" : "auto",
    automationMode: noAutoPr ? "AUTOMATION_MODE_UNSPECIFIED" : "AUTO_CREATE_PR" });
  const prompt = buildPrompt({ issueId: `qualification-${runKey}`, runId: runKey, title: String(issue.title),
    description: String(issue.description), isRetry: false }, config);
  const request: CreateSessionRequest = { prompt, title: String(issue.title),
    sourceContext: { source: config.source, githubRepoContext: { startingBranch: config.baseBranch } },
    requirePlanApproval: true, automationMode: config.automationMode };
  const end = Date.now() + 12 * 60_000;
  let completedAt = 0;
  do {
    const report = await qualifyPlanApprovalStep({ client, manifestPath, request, createAllowed });
    const latest = report.observations.at(-1)!;
    console.log(JSON.stringify({ sessionId: report.sessionId, state: latest.state, updatedAt: latest.updatedAt,
      activityKinds: latest.activities.map((entry) => entry.kind), outputCount: latest.outputCount, observedAt: latest.observedAt }));
    if (["COMPLETED", "FAILED"].includes(latest.state)) {
      if (!completedAt) completedAt = Date.now();
      if (Date.now() - completedAt >= 30_000) return;
      await new Promise((resolve) => setTimeout(resolve, Date.now() - completedAt < 10_000 ? 10_000 : 20_000));
    } else if (Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 30_000));
  } while (Date.now() < end || completedAt && Date.now() - completedAt < 30_000);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(() => { console.error("Jules approval qualification failed; inspect owner-only manifest, never replay create blindly."); process.exitCode = 1; });
}
