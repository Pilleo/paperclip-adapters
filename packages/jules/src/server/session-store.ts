import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { JulesAdapterSessionV1, sessionCodec, serializeSession } from "./session.js";

const SESSION_STORE_DIR_ENV = "PAPERCLIP_JULES_SESSION_STORE_DIR";

export function sessionStoreDirectory(): string | null {
  const configuredDirectory = process.env[SESSION_STORE_DIR_ENV];
  if (configuredDirectory) return configuredDirectory;

  // Unit tests intentionally opt in with a per-test temporary directory.
  // This prevents independently mocked executions with the same task ID from
  // sharing state through a developer's real Paperclip data directory.
  if (process.env["VITEST"]) return null;

  return join(homedir(), ".paperclip", "jules-adapter-sessions", "v2");
}

function sessionStorePath(
  directory: string,
  taskId: string,
  source: string,
  baseBranch: string,
): string {
  // Keep provider/source information out of the filesystem path while making
  // one durable record per Paperclip task and repository identity.
  const key = createHash("sha256")
    .update(`${taskId}\u0000${source}\u0000${baseBranch}`)
    .digest("hex");
  return join(directory, `${key}.json`);
}

export async function loadStoredSession(
  taskId: string,
  source: string,
  baseBranch: string,
): Promise<JulesAdapterSessionV1 | null> {
  const directory = sessionStoreDirectory();
  if (!directory) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(sessionStorePath(directory, taskId, source, baseBranch), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  const session = sessionCodec.decode(raw);
  if (!session ||
      session.paperclipIssueId !== taskId ||
      session.source !== source ||
      session.baseBranch !== baseBranch) {
    return null;
  }
  return session;
}

export async function saveStoredSession(session: JulesAdapterSessionV1): Promise<void> {
  const directory = sessionStoreDirectory();
  if (!directory) return;
  const serialized = serializeSession(session);
  if (!serialized) throw new Error("Cannot persist an invalid Jules session");

  const destination = sessionStorePath(
    directory,
    session.paperclipIssueId,
    session.source,
    session.baseBranch,
  );
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(serialized), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, destination);
}

export async function deleteStoredSession(
  taskId: string,
  source: string,
  baseBranch: string,
): Promise<void> {
  const directory = sessionStoreDirectory();
  if (!directory) return;
  try {
    await unlink(sessionStorePath(directory, taskId, source, baseBranch));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
