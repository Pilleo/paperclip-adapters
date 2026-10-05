import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile, rename, mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);
const repositoryName = "paperclip-contract/fixture";

/** A stateful local Git repository and read-only gh boundary; only the test actor can merge. */
export async function createChainGitHubFixture(root, { remote = false, initialFiles = {}, observePublishedHeads = false, enforceUpToDate = false } = {}) {
  const repository = path.join(root, "repository");
  const statePath = path.join(root, "github-state.json");
  const ghPath = path.join(root, "gh");
  await mkdir(repository);
  const git = async (...args) => (await exec("git", args, { cwd: repository, timeout: 10_000 })).stdout.trim();
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "External contract merger");
  await git("config", "user.email", "merger@example.test");
  for (const [file, body] of Object.entries(initialFiles)) {
    await mkdir(path.dirname(path.join(repository, file)), { recursive: true });
    await writeFile(path.join(repository, file), body);
  }
  await git("add", "--all");
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
  await persist({ repository, prs: [], remotePath: remote ? path.join(root, "remote.git") : null, observePublishedHeads, enforceUpToDate });
  await writeFile(ghPath, `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
const args = process.argv.slice(2);
const fail = () => { console.error('forbidden or unsupported gh command'); process.exit(1); };
const row = state.prs.find((pr) => pr.url === args[2] || String(pr.number) === args[2]);
const gitPrefix = state.observePublishedHeads && state.remotePath ? ['--git-dir', state.remotePath] : [];
const observedGit = (args) => execFileSync('git', [...gitPrefix, ...args], { cwd: state.repository, encoding: 'utf8', timeout: 10000 }).trim();
const observedHead = (pr) => {
  if (!state.observePublishedHeads || !pr.branch || pr.state !== 'OPEN') return pr.headSha;
  const head = observedGit(['rev-parse', 'refs/heads/' + pr.branch]);
  if (head !== pr.headSha) {
    pr.previousHeadSha = pr.headSha; pr.headSha = head;
    const base = observedGit(['rev-parse', 'refs/heads/main']);
    const included = spawnSync('git', [...gitPrefix, 'merge-base', '--is-ancestor', base, head], { cwd: state.repository, timeout: 10000 });
    if (included.error || ![0, 1].includes(included.status)) throw new Error('Base ancestry observation failed');
    if (included.status === 0) pr.baseSha = base;
    fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
  }
  return head;
};
const observedMergeability = new Map();
const mergeability = (pr) => {
  if (pr.state !== 'OPEN') return { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' };
  if (observedMergeability.has(pr.headSha)) return observedMergeability.get(pr.headSha);
  const head = observedHead(pr);
  const result = spawnSync('git', [...gitPrefix, 'merge-tree', '--write-tree', 'main', head],
    { cwd: state.repository, encoding: 'utf8', timeout: 10000 });
  if (result.error || ![0, 1].includes(result.status) || (result.status === 1 && !result.stdout.includes('CONFLICT'))) {
    throw new Error('Git mergeability observation failed: ' + (result.error?.message || result.stderr));
  }
  const observed = result.status === 0
    ? { mergeable: 'MERGEABLE', mergeStateStatus: state.enforceUpToDate && pr.baseSha !== observedGit(['rev-parse', 'main']) ? 'BEHIND' : 'CLEAN' }
    : { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
  observedMergeability.set(pr.headSha, observed);
  return observed;
};
const view = (pr) => ({ number: pr.number, title: pr.title, state: pr.state,
  headRefName: pr.branch, headRefOid: observedHead(pr), baseRefName: 'main',
  baseRefOid: observedGit(['rev-parse', 'main']),
  changedFiles: 1,
  mergedAt: pr.mergedAt || null, url: pr.url, files: [pr.file],
  ...mergeability(pr),
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
  process.stdout.write(execFileSync('git', [...gitPrefix, 'diff', 'main...' + observedHead(row), '--', row.file],
    { cwd: state.repository, encoding: 'utf8' }));
} else if (args[0] === 'api' && args.length === 4 && args[2] === '--method' && args[3] === 'GET' &&
  args[1].startsWith('repos/paperclip-contract/fixture/contents/')) {
  const [encoded, sha] = args[1].slice('repos/paperclip-contract/fixture/contents/'.length).split('?ref=');
  if (!encoded || !/^[0-9a-f]{40}$/.test(sha || '')) fail();
  const file = encoded.split('/').map(decodeURIComponent).join('/');
  if (!state.prs.some(pr => pr.file === file && observedHead(pr) === sha)) fail();
  const content = execFileSync('git', [...gitPrefix, 'show', sha + ':' + file], { cwd: state.repository, timeout: 10000 });
  console.log(JSON.stringify({ type: 'file', encoding: 'base64', size: content.length, content: content.toString('base64') }));
} else if (args[0] === 'api' && args.length === 6 && args[2] === '--method' && args[3] === 'GET' &&
  args[1].startsWith('repos/paperclip-contract/fixture/compare/')) {
  const [base, head] = args[1].slice('repos/paperclip-contract/fixture/compare/'.length).split('...');
  const pr = state.prs.find(pr => observedHead(pr) === head);
  if (!pr || !/^[0-9a-f]{40}$/.test(base || '') || !/^[0-9a-f]{40}$/.test(head || '')) fail();
  if (args[4] === '--header' && args[5] === 'Accept: application/vnd.github.diff') {
    process.stdout.write(execFileSync('git', [...gitPrefix, 'diff', base + '...' + head], { cwd: state.repository, encoding: 'utf8' }));
  } else if (args[4] === '--jq' && args[5] === '{baseSha: .base_commit.sha, mergeBaseSha: .merge_base_commit.sha, files: [.files[] | {path: .filename, status}]}') {
    const mergeBaseSha = observedGit(['merge-base', base, head]);
    const status = spawnSync('git', [...gitPrefix, 'cat-file', '-e', mergeBaseSha + ':' + pr.file], { cwd: state.repository });
    if (status.error || ![0, 1, 128].includes(status.status)) fail();
    console.log(JSON.stringify({ baseSha: base, mergeBaseSha, files: [{ path: pr.file, status: status.status === 0 ? 'modified' : 'added' }] }));
  } else fail();
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
      if (remote) await git("push", "origin", branch);
      await git("checkout", "main");
      const url = `https://github.com/${repositoryName}/pull/${number}`;
      state.prs.push({ number, title: `Canary ${label}`, branch, file, headSha, baseSha, url, state: "OPEN" });
      await persist(state);
      return { number, url, headSha, baseSha };
    },
    async repairPullRequest(url, resolutions) {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const pr = state.prs.find((candidate) => candidate.url === url && candidate.state === "OPEN");
      if (!pr || await git("rev-parse", pr.branch) !== pr.headSha) throw new Error("Provider repair requires the original open PR head");
      const oldHeadSha = pr.headSha;
      const baseSha = await git("rev-parse", "main");
      const worktree = await mkdtemp(path.join(root, "provider-repair-"));
      const workerGit = async (...args) => (await exec("git", args, { cwd: worktree, timeout: 10_000 })).stdout.trim();
      let added = false;
      try {
        await git("worktree", "add", worktree, pr.branch);
        added = true;
        try { await workerGit("merge", "--no-ff", "--no-commit", baseSha); }
        catch (error) {
          if (error.code !== 1 || !(await workerGit("diff", "--name-only", "--diff-filter=U"))) throw error;
        }
        for (const [file, body] of Object.entries(resolutions)) {
          await writeFile(path.join(worktree, file), body);
          await workerGit("add", "--", file);
        }
        if (await workerGit("diff", "--name-only", "--diff-filter=U")) throw new Error("Provider repair left unresolved conflicts");
        await workerGit("commit", "-m", "Resolve shared-file base advancement");
        pr.headSha = await workerGit("rev-parse", "HEAD");
        pr.baseSha = baseSha;
        if (remote) await workerGit("push", "origin", pr.branch);
        await persist(state);
        return { url, oldHeadSha, headSha: pr.headSha, baseSha };
      } finally {
        if (added) await git("worktree", "remove", "--force", worktree);
        else await rm(worktree, { recursive: true, force: true });
      }
    },
    async mergeExternalContribution(file, body) {
      // An outside-fleet Git actor creates its own PR; this cannot merge a
      // managed PR or substitute invented native verdicts for its review gate.
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const baseSha = await git("rev-parse", "main");
      const number = state.prs.length + 1;
      const branch = `external/contribution-${number}`;
      const worktree = await mkdtemp(path.join(root, "external-contribution-"));
      await git("worktree", "add", "-b", branch, worktree, baseSha);
      try {
        await writeFile(path.join(worktree, file), body);
        await exec("git", ["add", "--", file], { cwd: worktree, timeout: 10_000 });
        await exec("git", ["commit", "-m", "External contributor shared export"], { cwd: worktree, timeout: 10_000 });
        const headSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: worktree, timeout: 10_000 })).stdout.trim();
        await git("merge", "--no-ff", "-m", "External contributor standard merge", branch);
        const mergeSha = await git("rev-parse", "HEAD");
        const parents = (await git("show", "-s", "--format=%P", mergeSha)).split(" ");
        if (parents.length !== 2 || parents[0] !== baseSha || parents[1] !== headSha) throw new Error("External base advance must be a standard merge");
        if (remote) await git("push", "origin", "main");
        const url = `https://github.com/${repositoryName}/pull/${number}`;
        state.prs.push({ number, title: "External contributor shared export", branch, file, headSha, baseSha, url,
          state: "MERGED", mergeSha, mergedAt: new Date().toISOString() });
        await persist(state);
        return { url, headSha, mergeSha, baseSha };
      } finally {
        await git("worktree", "remove", "--force", worktree);
      }
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
      if (state.observePublishedHeads && await git("rev-parse", pr.branch) !== pr.headSha) {
        await git("fetch", "origin", `+refs/heads/${pr.branch}:refs/heads/${pr.branch}`);
      }
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
