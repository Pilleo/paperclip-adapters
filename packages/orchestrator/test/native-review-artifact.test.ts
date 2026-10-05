import { describe, expect, it } from "vitest";
import { readNativePullRequestArtifact } from "../src/core/native-review-artifact.js";

const headSha = "a".repeat(40), baseSha = "b".repeat(40);
const assignment = { prUrl: "https://github.com/owner/private-repo/pull/27", headSha };
const source = "module.exports = value => /^[0-9]+$/.test(value);\n";
const metadata = { url: assignment.prUrl, state: "OPEN", headRefOid: headSha, baseRefOid: baseSha,
  changedFiles: 1, files: [{ path: "numbers.js", changeType: "MODIFIED" }] };

describe("run-owned immutable native PR artifact", () => {
  it("returns the exact head source and diff through bounded read commands without modifying a checkout", async () => {
    const commands: readonly string[][] = [];
    const seen = commands as string[][];
    const snapshot = await readNativePullRequestArtifact(assignment, { env: { GH_TOKEN: "run-only-token" },
      run: async (args, options) => {
        seen.push([...args]);
        expect(options.env.GH_TOKEN).toBe("run-only-token");
        if (args[0] === "pr" && args[1] === "view") return JSON.stringify(metadata);
        if (args[0] === "pr" && args[1] === "diff") return "diff --git a/numbers.js b/numbers.js\n+decimal-only\n";
        if (args.includes("--header")) return "diff --git a/numbers.js b/numbers.js\n+decimal-only\n";
        if (args[1]?.includes('/compare/')) return JSON.stringify({ baseSha, mergeBaseSha: baseSha, files: [{ path: "numbers.js", status: "modified" }] });
        expect(args).toEqual(["api", `repos/owner/private-repo/contents/numbers.js?ref=${headSha}`, "--method", "GET"]);
        return JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(source).toString("base64"), size: Buffer.byteLength(source) });
      } });
    expect(snapshot).toMatchObject({ complete: true, headSha, baseSha, files: [{ path: "numbers.js", headContent: source }] });
    expect(snapshot.diff).toContain("decimal-only");
    expect(seen.filter(args => args[1] === "view")).toHaveLength(2);
    expect(seen.some(args => args.includes("checkout") || args.includes("merge"))).toBe(false);
  });

  it("fails closed when the PR head changes during artifact inspection", async () => {
    let reads = 0;
    await expect(readNativePullRequestArtifact(assignment, { run: async args => {
      if (args[1] === "view") return JSON.stringify({ ...metadata, headRefOid: ++reads === 1 ? headSha : "c".repeat(40) });
      if (args[1] === "diff") return "diff";
      if (args.includes("--header")) return "diff";
      if (args[1]?.includes('/compare/')) return JSON.stringify({ baseSha, mergeBaseSha: baseSha, files: [{ path: "numbers.js", status: "modified" }] });
      return JSON.stringify({ type: "file", encoding: "base64", content: "eA==", size: 1 });
    } })).rejects.toMatchObject({ code: "review_artifact_head_changed" });
  });

  it("refuses incomplete file lists rather than serving a partial review snapshot", async () => {
    await expect(readNativePullRequestArtifact(assignment, { run: async () => JSON.stringify({ ...metadata, changedFiles: 2 }) }))
      .rejects.toMatchObject({ code: "review_artifact_unavailable" });
  });

  it("refuses oversized artifacts rather than silently truncating code", async () => {
    await expect(readNativePullRequestArtifact(assignment, { maxBytes: 20, run: async args => args[1] === "view"
      ? JSON.stringify(metadata) : "x".repeat(100) })).rejects.toMatchObject({ code: "review_artifact_too_large" });
  });

  it("rejects non-GitHub and traversal targets before invoking a command", async () => {
    let commands = 0;
    await expect(readNativePullRequestArtifact({ ...assignment, prUrl: "https://example.com/owner/repo/pull/27" },
      { run: async () => { commands++; return ""; } })).rejects.toMatchObject({ code: "review_artifact_unavailable" });
    expect(commands).toBe(0);
    await expect(readNativePullRequestArtifact(assignment, { run: async () => JSON.stringify({ ...metadata,
      files: [{ path: "../secret", changeType: "MODIFIED" }] }) })).rejects.toMatchObject({ code: "review_artifact_unavailable" });
  });

  it("represents a removed file without fetching nonexistent head contents even when gh view has no changeType", async () => {
    const seen: string[][] = [];
    const snapshot = await readNativePullRequestArtifact(assignment, { run: async args => {
      seen.push([...args]);
      if (args[1] === "view") return JSON.stringify({ ...metadata, files: [{ path: "gone.js", additions: 0, deletions: 3 }] });
      if (args[1] === "diff" || args.includes("--header")) return "diff --git a/gone.js b/gone.js\ndeleted file mode 100644\n";
      if (args[1]?.includes('/compare/')) return JSON.stringify({ baseSha, mergeBaseSha: baseSha,
        files: [{ path: "gone.js", status: "removed" }] });
      throw new Error("HTTP 404: the deleted path has no head contents");
    } });
    expect(snapshot.files).toEqual([{ path: "gone.js", headContent: null }]);
    expect(seen.some(args => args[1]?.includes('/contents/'))).toBe(false);
  });

  it("reads the diff by immutable commit identifiers instead of accepting an ABA PR-number snapshot", async () => {
    let mutableDiffRead = false;
    const snapshot = await readNativePullRequestArtifact(assignment, { run: async args => {
      if (args[1] === "view") return JSON.stringify(metadata);
      if (args[1] === "diff") { mutableDiffRead = true; return "diff from intervening head B"; }
      if (args.includes("--header")) return "diff from immutable head A";
      if (args[1]?.includes('/compare/')) return JSON.stringify({ baseSha, mergeBaseSha: baseSha,
        files: [{ path: "numbers.js", status: "modified" }] });
      return JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(source).toString('base64'), size: Buffer.byteLength(source) });
    } });
    expect(snapshot.diff).toBe("diff from immutable head A");
    expect(mutableDiffRead).toBe(false);
  });

  it("bounds the serialized MCP artifact as well as raw source bytes", async () => {
    const escaped = '"'.repeat(300);
    await expect(readNativePullRequestArtifact(assignment, { maxBytes: 500, run: async args => {
      if (args[1] === "view") return JSON.stringify(metadata);
      if (args.includes("--header")) return "x";
      if (args[1]?.includes('/compare/')) return JSON.stringify({ baseSha, mergeBaseSha: baseSha, files: [{ path: "numbers.js", status: "modified" }] });
      return JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(escaped).toString('base64'), size: Buffer.byteLength(escaped) });
    } })).rejects.toMatchObject({ code: "review_artifact_too_large" });
  });
});
