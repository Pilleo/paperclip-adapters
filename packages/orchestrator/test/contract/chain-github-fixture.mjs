import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);
const repositoryName = "paperclip-contract/fixture";

/** A stateful local Git repository and read-only gh boundary; only the test actor can merge. */
export async function createChainGitHubFixture(root, { remote = false } = {}) {
  const repository = path.join(root, "repository");
  const statePath = path.join(root, "github-state.json");
  const ghPath = path.join(root, "gh");
  await mkdir(repository);
  const git = async (...args) => (await exec("git", args, { cwd: repository, timeout: 10_000 })).stdout.trim();
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "External contract merger");
  await git("config", "user.email", "merger@example.test");
  await git("commit", "--allow-empty", "-m", "Initial canary repository");
  const initialSha = await git("rev-parse", "HEAD");
  const repoUrl = `https://github.com/${repositoryName}.git`;
  if (remote) {
    const remotePath = path.join(root, "remote.git");
    await git("clone", "--bare", repository, remotePath);
    // Keep canonical repository identity while Git transports the exact URI
    // exclusively to a local bare repository owned by this fixture.
    await git("config", `url.file://${remotePath}.insteadOf`, repoUrl);
    await git("remote", "add", "origin", repoUrl);
    await git("fetch", "origin", "main");
    await git("branch", "--set-upstream-to=origin/main", "main");
  }
  const persist = async (state) => {
    const temporary = `${statePath}.pending`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, statePath);
  };
  await persist({ repository, prs: [] });
  await writeFile(ghPath, `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
const args = process.argv.slice(2);
const fail = () => { console.error('forbidden or unsupported gh command'); process.exit(1); };
const row = state.prs.find((pr) => pr.url === args[2] || String(pr.number) === args[2]);
const view = (pr) => ({ number: pr.number, title: pr.title, state: pr.state,
  headRefName: pr.branch, headRefOid: pr.headSha, baseRefName: 'main',
  mergedAt: pr.mergedAt || null, url: pr.url, files: [pr.file],
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  mergeCommit: pr.mergeSha ? { oid: pr.mergeSha } : null });
if (args[0] === 'pr' && args[1] === 'view' && row && args[3] === '--json') {
  const fields = args[4]?.split(',') || [];
  if (args.length !== 5 || !fields.every((field) => field in view(row))) fail();
  const selected = Object.fromEntries(fields.map((field) => [field, view(row)[field]]));
  console.log(JSON.stringify(selected));
} else if (args[0] === 'pr' && args[1] === 'list' && args[2] === '--repo' &&
  args[3] === ${JSON.stringify(repositoryName)} && args[4] === '--state' && args[5] === 'all' &&
  args[6] === '--limit' && args[8] === '--json' && args.length === 10) {
  const fields = args[9]?.split(',') || [];
  if (!fields.every((field) => field in view(state.prs[0] || { number: 0 }))) fail();
  console.log(JSON.stringify(state.prs.map((pr) => Object.fromEntries(fields.map((field) => [field, view(pr)[field]])))));
} else if (args[0] === 'pr' && args[1] === 'checks' && row && args[3] === '--repo' &&
  args[4] === ${JSON.stringify(repositoryName)} && args[5] === '--json' &&
  args[6] === 'state,bucket,name' && args.length === 7) {
  console.log(JSON.stringify([{ state: 'SUCCESS', bucket: 'pass', name: 'contract' }]));
} else if (args[0] === 'pr' && args[1] === 'checks' && row && args[3] === '--json' &&
  args[4] === 'bucket,state,name,workflow,startedAt' && args.length === 5) {
  console.log(JSON.stringify([{ bucket: 'pass', state: 'SUCCESS', name: 'contract', workflow: 'contract', startedAt: '2026-09-28T00:00:00Z' }]));
} else if (args[0] === 'pr' && args[1] === 'diff' && row && args.length === 4 && args[3] === '--name-only') {
  console.log(row.file);
} else if (args[0] === 'pr' && args[1] === 'diff' && row && args.length === 3) {
  process.stdout.write(execFileSync('git', ['show', '--format=', row.headSha, '--', row.file],
    { cwd: state.repository, encoding: 'utf8' }));
} else if (args[0] === 'api' && args[1]?.startsWith('repos/paperclip-contract/fixture/git/commits/') &&
  /^[0-9a-f]{40}$/.test(args[1].split('/').at(-1)) && args.length === 2) {
  const sha = args[1].split('/').at(-1);
  if (!state.prs.some((pr) => pr.mergeSha === sha)) fail();
  const parents = execFileSync('git', ['show', '-s', '--format=%P', sha], { cwd: state.repository, encoding: 'utf8' }).trim().split(' ');
  console.log(JSON.stringify({ sha, parents: parents.map((parent) => ({ sha: parent })) }));
} else fail();
`);
  await chmod(ghPath, 0o700);

  return {
    repository, initialSha, ghPath, ...(remote ? { repoUrl } : {}),
    async openPullRequest(label, file, text) {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const baseSha = await git("rev-parse", "HEAD");
      const number = state.prs.length + 1;
      const branch = `fixture/${label}-${number}`;
      await git("checkout", "-b", branch);
      await writeFile(path.join(repository, file), text);
      await git("add", "--", file);
      await git("commit", "-m", `Implement ${label}`);
      const headSha = await git("rev-parse", "HEAD");
      await git("checkout", "main");
      const url = `https://github.com/${repositoryName}/pull/${number}`;
      state.prs.push({ number, title: `Canary ${label}`, branch, file, headSha, baseSha, url, state: "OPEN" });
      await persist(state);
      return { number, url, headSha, baseSha };
    },
    async externalMerge(url, evidence) {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const pr = state.prs.find((candidate) => candidate.url === url && candidate.state === "OPEN");
      if (!pr) throw new Error(`No open PR to merge: ${url}`);
      const reviews = evidence?.reviews;
      if (!Array.isArray(reviews)) throw new Error("External merge requires addressed native review evidence");
      if (evidence?.headSha !== pr.headSha) throw new Error("External merge requires the exact reviewed head");
      if (reviews.length !== 2 || reviews[0]?.stage !== "luna" ||
          reviews[1]?.stage !== "strong" || reviews[0]?.reviewerAgentId === reviews[1]?.reviewerAgentId ||
          reviews.some((review) => review.verdict !== "approve" ||
            !["reviewerAgentId", "cardId", "sourceRunId", "resolvedByRunId"].every((key) =>
              typeof review[key] === "string" && review[key].length > 0) ||
            review.sourceRunId === review.resolvedByRunId) ||
          reviews[0].cardId === reviews[1].cardId) {
        throw new Error("External merge requires two distinct addressed native review evidence records");
      }
      if (await git("rev-parse", "HEAD") !== pr.baseSha) throw new Error("PR base changed before external merge");
      if (await git("rev-parse", pr.branch) !== pr.headSha) throw new Error("PR head changed before external merge");
      await git("merge", "--no-ff", "-m", `External merge PR #${pr.number}`, pr.branch);
      const mergeSha = await git("rev-parse", "HEAD");
      const parents = (await git("rev-list", "--parents", "-n", "1", mergeSha)).split(" ");
      if (parents.length !== 3 || parents[1] !== pr.baseSha || parents[2] !== pr.headSha) {
        throw new Error("External merge did not preserve the reviewed head as its second parent");
      }
      pr.state = "MERGED";
      pr.mergeSha = mergeSha;
      pr.mergedAt = new Date().toISOString();
      if (remote) await git("push", "origin", "main");
      await persist(state);
      return { mergeSha, headSha: pr.headSha };
    },
  };
}
