import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { JulesClient, JulesClientError } from "./jules-client.js";

export interface ReadinessCheck {
  code: string;
  ok: boolean;
  message: string;
}

export async function checkLocalState(directory: string): Promise<ReadinessCheck> {
  const probe = join(directory, `.readiness-${randomUUID()}`);
  try {
    await mkdir(directory, { recursive: true });
    await access(directory, constants.R_OK | constants.W_OK);
    await writeFile(probe, "ok", { encoding: "utf8", mode: 0o600 });
    await unlink(probe);
    return { code: "local_state_ready", ok: true, message: `Local state is readable and writable: ${directory}` };
  } catch (error) {
    try { await unlink(probe); } catch { /* best effort */ }
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    return {
      code: "local_state_unavailable",
      ok: false,
      message: `Local state directory is not writable (${code}): ${directory}. Fix ownership/permissions or configure PAPERCLIP_JULES_SESSION_STORE_DIR.`,
    };
  }
}

export async function checkJulesCredentials(client: JulesClient): Promise<ReadinessCheck> {
  try {
    // A one-item list is read-only and never creates Jules work.
    await client.listSessions(1);
    return { code: "jules_credentials_ready", ok: true, message: "Jules credentials are valid." };
  } catch (error) {
    const status = error instanceof JulesClientError
      ? error.status
      : (typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status: unknown }).status)
        : null);
    if (status === 401 || status === 403) {
      return {
        code: "jules_credentials_invalid",
        ok: false,
        message: "Jules rejected the configured credential. Rotate JULES_API_KEY and re-run readiness.",
      };
    }
    return {
      code: "jules_api_unavailable",
      ok: false,
      message: "Jules credential verification could not complete. Check network/rate-limit status and retry readiness.",
    };
  }
}
