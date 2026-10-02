import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

/** External local-worker provider; Git repair is an operation actor, API publication uses this worker's actual credentials. */
export async function createLocalAcpRepairFixture(root, operationUrl, operationToken) {
  const serverPath = path.join(root, "vibe_acp_repair.cjs");
  await writeFile(serverPath, `#!/usr/bin/env node
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const options = [{ id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'mistral-medium-3.5', options: [{ value: 'mistral-medium-3.5', name: 'Local worker fixture' }] }];
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const api = async (route, method = 'GET', body) => {
  const env = process.env;
  if (!env.PAPERCLIP_API_KEY || !env.PAPERCLIP_RUN_ID || !env.PAPERCLIP_API_URL) throw new Error('Missing local worker runtime credentials');
  const response = await fetch(env.PAPERCLIP_API_URL + '/api' + route, { method,
    headers: { Authorization: 'Bearer ' + env.PAPERCLIP_API_KEY, 'X-Paperclip-Run-Id': env.PAPERCLIP_RUN_ID, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Local worker API failed (' + response.status + '): ' + await response.text());
  return response.json();
};
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  try {
    let result;
    switch (message.method) {
      case 'initialize': result = { protocolVersion: 1, agentInfo: { name: 'local-worker-fixture', version: '1' }, agentCapabilities: { mcpCapabilities: { http: true }, promptCapabilities: {} }, authMethods: [] }; break;
      case 'session/new': result = { sessionId: randomUUID(), configOptions: options }; break;
      case 'session/set_model': case 'session/set_mode': result = {}; break;
      case 'session/set_config_option': result = { configOptions: options }; break;
      case 'session/prompt': {
        const run = await api('/heartbeat-runs/' + process.env.PAPERCLIP_RUN_ID);
        if (run.agentId !== process.env.PAPERCLIP_AGENT_ID) throw new Error('Local worker run identity mismatch');
        const issueId = run.contextSnapshot.issueId;
        const issue = await api('/issues/' + issueId);
        if (issue.assigneeAgentId !== run.agentId) throw new Error('Local worker does not own the repair task');
        const response = await fetch(${JSON.stringify(operationUrl)}, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ${JSON.stringify(operationToken)} },
          body: JSON.stringify({ issueId, agentId: run.agentId }), signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error('Provider Git repair failed (' + response.status + '): ' + await response.text());
        const repaired = await response.json();
        await api('/work-products/' + repaired.productId, 'PATCH', { isPrimary: true, metadata: repaired.metadata });
        await api('/issues/' + issueId + '/comments', 'POST', { body: 'Local conflict repair published the existing PR at ' + repaired.metadata.headSha + '. Both contributor exports are preserved; fresh native review is required.' });
        await api('/issues/' + issueId, 'PATCH', { status: 'in_progress', assigneeAgentId: repaired.publisherAgentId });
        send({ method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Existing PR branch repaired and handed back to its original publisher for native review.' } } } });
        result = { stopReason: 'end_turn' }; break;
      }
      default: send({ id: message.id, error: { code: -32601, message: 'Unsupported ACP method' } }); return;
    }
    send({ id: message.id, result });
  } catch (error) { send({ id: message.id, error: { code: -32000, message: error.message } }); }
});
`, { mode: 0o700 });
  await chmod(serverPath, 0o700);
  return { serverPath };
}
