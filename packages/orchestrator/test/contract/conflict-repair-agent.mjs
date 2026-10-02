import { writeFile } from "node:fs/promises";
import path from "node:path";

/** An independent process agent using only its actual native task/run credentials. */
export async function createConflictRepairAgent(root, operationUrl, token) {
  const script = path.join(root, "conflict-repair-agent.mjs");
  await writeFile(script, `const env = process.env;
const headers = { Authorization: 'Bearer ' + env.PAPERCLIP_API_KEY, 'X-Paperclip-Run-Id': env.PAPERCLIP_RUN_ID, 'Content-Type': 'application/json' };
const api = async (route, method = 'GET', body) => {
  const response = await fetch(env.PAPERCLIP_API_URL + '/api' + route, { method, headers,
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(method + ' ' + route + ': ' + await response.text());
  return response.json();
};
const run = await api('/heartbeat-runs/' + env.PAPERCLIP_RUN_ID);
const issueId = run.contextSnapshot.issueId;
const task = await api('/issues/' + issueId);
if (run.agentId !== env.PAPERCLIP_AGENT_ID || task.assigneeAgentId !== run.agentId) throw new Error('Repair ownership mismatch');
const response = await fetch(${JSON.stringify(operationUrl)}, { method: 'POST',
  headers: { Authorization: 'Bearer ' + ${JSON.stringify(token)}, 'Content-Type': 'application/json' },
  body: JSON.stringify({ issueId, agentId: run.agentId, runId: run.id }), signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error('Git operation failed: ' + await response.text());
const repaired = await response.json();
await api('/issues/' + issueId + '/work-products', 'POST', { type: 'pull_request', provider: 'github', url: repaired.url,
  title: 'Resolved existing PR', status: 'ready_for_review', isPrimary: true,
  metadata: { headSha: repaired.headSha, conflictAttemptId: repaired.attemptId } });
await api('/issues/' + issueId, 'PATCH', { status: 'done' });
console.log(JSON.stringify({ provider: 'process', prUrl: repaired.url, headSha: repaired.headSha }));
`, { mode: 0o700 });
  return { command: process.execPath, args: [script] };
}
