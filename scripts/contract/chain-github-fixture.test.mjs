import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { createChainGitHubFixture } from "../../packages/orchestrator/test/contract/chain-github-fixture.mjs";

const run = promisify(execFile);
const reviewEvidence = (headSha, label) => ({ headSha, reviews: [
  { stage: "luna", reviewerAgentId: "luna", cardId: `${label}-luna`, sourceRunId: `${label}-source-luna`, resolvedByRunId: `${label}-review-luna`, verdict: "approve" },
  { stage: "strong", reviewerAgentId: "strong", cardId: `${label}-strong`, sourceRunId: `${label}-source-strong`, resolvedByRunId: `${label}-review-strong`, verdict: "approve" },
] });

test("real overlapping export edits become conflicting after an external base merge without changing the checkout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paperclip-chain-conflict-"));
  try {
    const fixture = await createChainGitHubFixture(root);
    await writeFile(path.join(fixture.repository, "shared.cjs"), "module.exports = { increment: n => n + 1 };\n");
    await run("git", ["add", "shared.cjs"], { cwd: fixture.repository });
    await run("git", ["commit", "-m", "Seed shared exports"], { cwd: fixture.repository });
    const b = await fixture.openPullRequest("B", "shared.cjs", "module.exports = { increment: n => n + 1, decrement: n => n - 1 };\n");
    const c = await fixture.openPullRequest("C", "shared.cjs", "module.exports = { increment: n => n + 1, double: n => n * 2 };\n");
    const merged = await fixture.externalMerge(c.url, reviewEvidence(c.headSha, "C"));
    await assert.rejects(run("git", ["merge-tree", "--write-tree", "main", b.headSha], { cwd: fixture.repository }),
      (error) => error.code === 1 && error.stdout.includes("CONFLICT"));
    const view = JSON.parse((await run(fixture.ghPath, ["pr", "view", b.url, "--json", "mergeable,mergeStateStatus,headRefOid"])).stdout);
    assert.deepEqual(view, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", headRefOid: b.headSha });
    const inventory = JSON.parse((await run(fixture.ghPath, ["pr", "list", "--repo", "paperclip-contract/fixture", "--state", "all", "--limit", "50", "--json", "number,mergeable,mergeStateStatus"])).stdout);
    assert.equal(inventory.find((pr) => pr.number === b.number).mergeable, "CONFLICTING");
    assert.equal((await run("git", ["status", "--porcelain"], { cwd: fixture.repository })).stdout, "");
    assert.equal((await run("git", ["rev-parse", "HEAD"], { cwd: fixture.repository })).stdout.trim(), merged.mergeSha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured GitHub remote is served by a real isolated bare Git transport", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paperclip-chain-remote-"));
  try {
    const fixture = await createChainGitHubFixture(root, { remote: true });
    assert.equal(fixture.repoUrl, "https://github.com/paperclip-contract/fixture.git");
    const remote = (await run("git", ["ls-remote", fixture.repoUrl, "main"], { cwd: fixture.repository })).stdout.trim();
    assert.equal(remote.split(/\s+/)[0], fixture.initialSha);
    await run("git", ["fetch", "origin", "main"], { cwd: fixture.repository });
    assert.equal((await run("git", ["rev-parse", "origin/main"], { cwd: fixture.repository })).stdout.trim(), fixture.initialSha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unreadable Git revision fails observation instead of being reported as a merge conflict", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paperclip-chain-invalid-revision-"));
  try {
    const fixture = await createChainGitHubFixture(root);
    const pr = await fixture.openPullRequest("A", "A.txt", "alpha");
    const statePath = path.join(root, "github-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.prs[0].headSha = "f".repeat(40);
    await writeFile(statePath, JSON.stringify(state));
    await assert.rejects(run(fixture.ghPath, ["pr", "view", pr.url, "--json", "mergeable"]), /Git mergeability observation failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external actor merges A then B then C into real two-parent commits with final files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paperclip-chain-git-"));
  try {
    const fixture = await createChainGitHubFixture(root, { remote: true });
    let previousMerge;
    for (const [label, text] of [["A", "alpha"], ["B", "beta"], ["C", "gamma"]]) {
      const pr = await fixture.openPullRequest(label, `${label}.txt`, text);
      assert.equal(pr.baseSha, previousMerge ?? fixture.initialSha);
      const view = JSON.parse((await run(fixture.ghPath, ["pr", "view", pr.url, "--json", "state,headRefOid,mergeCommit"])).stdout);
      assert.equal(view.state, "OPEN");
      assert.equal(view.headRefOid, pr.headSha);
      const checks = JSON.parse((await run(fixture.ghPath, ["pr", "checks", pr.url,
        "--json", "bucket,state,name,workflow,startedAt"])).stdout);
      assert.equal(checks[0].bucket, "pass");
      assert.equal((await run(fixture.ghPath, ["pr", "diff", pr.url, "--name-only"])).stdout.trim(), `${label}.txt`);
      const detailed = JSON.parse((await run(fixture.ghPath, ["pr", "view", pr.url, "--json",
        "state,mergedAt,mergeable,mergeStateStatus,headRefOid,headRefName"])).stdout);
      assert.equal(detailed.mergeable, "MERGEABLE");
      await assert.rejects(fixture.externalMerge(pr.url), /native.*review|review.*evidence/i);
      const evidence = { headSha: pr.headSha, reviews: [
        { stage: "luna", reviewerAgentId: "luna", cardId: `${label}-luna`, sourceRunId: `${label}-bootstrap-luna`,
          resolvedByRunId: `${label}-review-luna`, verdict: "approve" },
        { stage: "strong", reviewerAgentId: "strong", cardId: `${label}-strong`, sourceRunId: `${label}-bootstrap-strong`,
          resolvedByRunId: `${label}-review-strong`, verdict: "approve" },
      ] };
      await assert.rejects(fixture.externalMerge(pr.url, { ...evidence, headSha: "f".repeat(40) }), /reviewed head/i);
      const merged = await fixture.externalMerge(pr.url, evidence);
      const parents = (await run("git", ["rev-list", "--parents", "-n", "1", merged.mergeSha], { cwd: fixture.repository })).stdout.trim().split(" ");
      assert.deepEqual(parents, [merged.mergeSha, pr.baseSha, pr.headSha]);
      const remote = (await run("git", ["ls-remote", fixture.repoUrl, "main"], { cwd: fixture.repository })).stdout.trim();
      assert.equal(remote.split(/\s+/)[0], merged.mergeSha, "external merge actor must publish the verified merge to the real remote");
      const after = JSON.parse((await run(fixture.ghPath, ["pr", "view", pr.url, "--json", "state,headRefOid,mergeCommit"])).stdout);
      assert.deepEqual(after, { state: "MERGED", headRefOid: pr.headSha, mergeCommit: { oid: merged.mergeSha } });
      previousMerge = merged.mergeSha;
    }
    for (const [label, text] of [["A", "alpha"], ["B", "beta"], ["C", "gamma"]]) {
      assert.equal(await readFile(path.join(fixture.repository, `${label}.txt`), "utf8"), text);
    }
    await assert.rejects(run(fixture.ghPath, ["pr", "merge", "3"]), /forbidden|disabled/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dependent PR prepared before its predecessor merge cannot be silently merged on a stale base", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paperclip-chain-early-"));
  try {
    const fixture = await createChainGitHubFixture(root);
    const a = await fixture.openPullRequest("A", "A.txt", "alpha");
    const b = await fixture.openPullRequest("B", "B.txt", "beta");
    const reviews = (headSha) => ({ headSha, reviews: [
      { stage: "luna", reviewerAgentId: "luna", cardId: "card-1", sourceRunId: "bootstrap-1", resolvedByRunId: "review-1", verdict: "approve" },
      { stage: "strong", reviewerAgentId: "strong", cardId: "card-2", sourceRunId: "bootstrap-2", resolvedByRunId: "review-2", verdict: "approve" },
    ] });
    await fixture.externalMerge(a.url, reviews(a.headSha));
    const mergeability = JSON.parse((await run(fixture.ghPath, ["pr", "view", b.url, "--json", "mergeable,mergeStateStatus"])).stdout);
    assert.deepEqual(mergeability, { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
      "base advancement with disjoint edits must remain distinct from a genuine Git conflict");
    await assert.rejects(fixture.externalMerge(b.url, reviews(b.headSha)), /base changed/i);
    const bState = JSON.parse((await run(fixture.ghPath, ["pr", "view", b.url, "--json", "state"])).stdout);
    assert.equal(bState.state, "OPEN");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
