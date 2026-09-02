import { describe, expect, it } from "vitest";
import { ConvergenceGuard } from "../src/core/convergence-guard.js";

describe("ConvergenceGuard", () => {
  it("allows only one concurrent owner for a logical effect", async () => {
    const guard = new ConvergenceGuard();
    const entered: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });

    const first = guard.runOnce("merge:issue-834:pr-3", async () => {
      entered.push("first");
      await hold;
      return "committed";
    });
    await Promise.resolve();

    const second = guard.runOnce("merge:issue-834:pr-3", async () => {
      entered.push("second");
      return "duplicate";
    });

    release();
    await expect(first).resolves.toBe("committed");
    await expect(second).resolves.toBe("committed");
    expect(entered).toEqual(["first"]);
  });

  it("retries after a failed effect instead of poisoning the key", async () => {
    const guard = new ConvergenceGuard();
    let attempts = 0;

    await expect(guard.runOnce("merge:issue-1:pr-1", async () => {
      attempts++;
      throw new Error("transient");
    })).rejects.toThrow("transient");

    await expect(guard.runOnce("merge:issue-1:pr-1", async () => {
      attempts++;
      return "ok";
    })).resolves.toBe("ok");
    expect(attempts).toBe(2);
  });

  it("returns the committed result to sequential replays", async () => {
    const guard = new ConvergenceGuard();
    let calls = 0;
    const effect = async () => {
      calls++;
      return { auditId: "comment-1" };
    };

    await expect(guard.runOnce("merge:issue-1:pr-1", effect)).resolves.toEqual({ auditId: "comment-1" });
    await expect(guard.runOnce("merge:issue-1:pr-1", effect)).resolves.toEqual({ auditId: "comment-1" });
    expect(calls).toBe(1);
  });
});
