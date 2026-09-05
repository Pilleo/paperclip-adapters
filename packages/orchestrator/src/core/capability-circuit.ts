/**
 * Suppresses operations that the currently running Paperclip server has
 * explicitly declared unavailable to this adapter. A 401/403 is a capability
 * decision, not a transient transport failure; retrying it on every scheduler
 * tick only hides useful signal in the board activity log.
 *
 * Paperclip may start a fresh adapter process for every heartbeat, so this
 * circuit uses optional per-key marker files to survive that boundary. The
 * markers contain only a truncated diagnostic and never credentials. A
 * successful probe removes the marker.
 */
import fs from "node:fs";
import path from "node:path";
import { isReviewerEligibilityFailure } from "./reviewer-eligibility.js";

export class CapabilityCircuit {
  private readonly denied = new Map<string, { status: number; detail: string }>();

  constructor(private readonly stateDir?: string) {}

  private statePath(key: string): string | null {
    return this.stateDir ? path.join(this.stateDir, `${encodeURIComponent(key)}.json`) : null;
  }

  private load(key: string): { status: number; detail: string } | null {
    const memory = this.denied.get(key);
    if (memory) return memory;
    const marker = this.statePath(key);
    if (!marker) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(marker, "utf8")) as { status?: unknown; detail?: unknown };
      if (typeof parsed.status !== "number" || typeof parsed.detail !== "string") return null;
      const denial = { status: parsed.status, detail: parsed.detail.slice(0, 300) };
      this.denied.set(key, denial);
      return denial;
    } catch {
      return null;
    }
  }

  private persist(key: string, denial: { status: number; detail: string }): void {
    const marker = this.statePath(key);
    if (!marker) return;
    try {
      fs.mkdirSync(this.stateDir!, { recursive: true });
      fs.writeFileSync(marker, JSON.stringify(denial), { encoding: "utf8", flag: "wx" });
    } catch (error: unknown) {
      // EEXIST means another adapter process won the claim. The marker is
      // still the desired durable state; other filesystem failures must not
      // make a Paperclip heartbeat fail.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return;
    }
  }

  private remove(key: string): void {
    this.denied.delete(key);
    const marker = this.statePath(key);
    if (!marker) return;
    try { fs.unlinkSync(marker); } catch { /* already removed */ }
  }

  isOpen(key: string): boolean {
    return this.load(key) !== null;
  }

  record(key: string, result: { ok: boolean; status: number; text: string }): "opened" | "already_open" | "closed" {
    if (result.ok) {
      this.remove(key);
      return "closed";
    }
    if (result.status !== 401 && result.status !== 403) return "closed";
    if (this.load(key)) return "already_open";
    const denial = { status: result.status, detail: result.text.slice(0, 300) };
    this.denied.set(key, denial);
    this.persist(key, denial);
    return "opened";
  }

  denial(key: string): { status: number; detail: string } | null {
    return this.load(key);
  }

  snapshot(): Array<{ key: string; status: number; detail: string }> {
    if (this.stateDir) {
      try {
        for (const file of fs.readdirSync(this.stateDir)) {
          if (!file.endsWith(".json")) continue;
          const key = decodeURIComponent(file.slice(0, -5));
          this.load(key);
        }
      } catch { /* state directory may not exist yet */ }
    }
    return Array.from(this.denied, ([key, denial]) => ({ key, ...denial }));
  }
}

export const capabilityCircuit = new CapabilityCircuit(
  process.env["PAPERCLIP_ADAPTER_STATE_DIR"] || "/tmp/paperclip-adapters-capability-circuit",
);
