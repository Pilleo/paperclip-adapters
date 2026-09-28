import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import type { JulesAdapterSessionV1 } from "./session.js";
import { adoptExternallyApprovedPlan } from "./external-plan-approval-recovery.js";
import { loadStoredSession, saveStoredSession } from "./session-store.js";

type Evidence = Parameters<typeof adoptExternallyApprovedPlan>[1];
type OperatorJournal = {
  readonly state: "intent" | "confirmed";
  readonly effectId: string;
  readonly issueId: string;
  readonly sessionId: string;
  readonly revisionId: string;
  readonly providerPrUrl: string;
};

async function readJournal(file: string): Promise<OperatorJournal | null> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 131072) {
      throw new Error("External approval journal must remain owner-only");
    }
    const value = JSON.parse(await handle.readFile("utf8")) as OperatorJournal;
    if (value.state !== "intent" && value.state !== "confirmed") throw new Error("Invalid external approval journal state");
    return value;
  } finally { await handle.close(); }
}

async function writeJournal(file: string, value: OperatorJournal, exclusive: boolean): Promise<void> {
  const destination = exclusive ? file : `${file}.${randomUUID()}.tmp`;
  const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  if (!exclusive) await rename(destination, file);
}

/** Crash-resumable local adoption; this never invokes Jules or mutates Paperclip. */
export async function persistExternalApprovalCheckpoint(input: {
  readonly session: JulesAdapterSessionV1;
  readonly evidence: Evidence;
  readonly journalPath: string;
}): Promise<{ readonly status: "confirmed" | "already_confirmed"; readonly session: JulesAdapterSessionV1 }> {
  const { session, evidence, journalPath } = input;
  const receipt = evidence.receipt;
  const identity: OperatorJournal = { state: "intent", effectId: receipt.effectId, issueId: receipt.issueId,
    sessionId: receipt.sessionId, revisionId: receipt.revisionId, providerPrUrl: evidence.providerPrUrl };
  const adopted = adoptExternallyApprovedPlan(session, evidence);
  let journal = await readJournal(journalPath);
  if (journal && (journal.effectId !== identity.effectId || journal.issueId !== identity.issueId ||
      journal.sessionId !== identity.sessionId || journal.revisionId !== identity.revisionId ||
      journal.providerPrUrl !== identity.providerPrUrl)) throw new Error("External approval journal belongs to another reviewed plan");
  if (journal?.state === "confirmed") {
    if (adopted !== session) throw new Error("Confirmed operator journal has no durable Jules approval effect");
    return { status: "already_confirmed", session };
  }
  if (!journal) {
    if (adopted === session) throw new Error("Jules approval effect exists without an operator journal");
    await writeJournal(journalPath, identity, true);
    journal = identity;
  }
  if (adopted !== session) await saveStoredSession(adopted);
  const recovered = await loadStoredSession(session.paperclipIssueId, session.source, session.baseBranch);
  if (recovered?.lifecycleEffectJournal?.effects.find((effect) => effect.effectId === receipt.effectId)?.attempt.kind !== "confirmed" ||
      recovered.childPlanReview !== undefined || recovered.planApprovedActivityId !== receipt.planActivityId) {
    throw new Error("Externally approved Jules checkpoint did not persist cleanly");
  }
  await writeJournal(journalPath, { ...journal, state: "confirmed" }, false);
  return { status: "confirmed", session: recovered };
}
