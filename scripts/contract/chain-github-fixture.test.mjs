import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { createChainGitHubFixture } from "../../packages/orchestrator/test/contract/chain-github-fixture.mjs";

const run = promisify(execFile);

test("external actor merges A then B then C into real two-parent commits with final files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paperclip-chain-git-"));
  try {
    const fixture = await createChainGitHubFixture(root);
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
    await assert.rejects(fixture.externalMerge(b.url, reviews(b.headSha)), /base changed/i);
    const bState = JSON.parse((await run(fixture.ghPath, ["pr", "view", b.url, "--json", "state"])).stdout);
    assert.equal(bState.state, "OPEN");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
