import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

/** External ACP provider simulator; all verdict writes go through the real adapter-owned MCP bridge. */
export async function createNativeAcpFixture(root, { reviewDecisionUrl, reviewDecisionToken } = {}) {
  const serverPath = path.join(root, "agy_acp_server.par");
  await writeFile(serverPath, `#!/usr/bin/env node
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const sessions = new Map();
const reviewDecisionUrl = ${JSON.stringify(reviewDecisionUrl ?? null)};
const reviewDecisionToken = ${JSON.stringify(reviewDecisionToken ?? null)};
const reviewPolicy = async (phase, assignment, verdict) => {
  const response = await fetch(reviewDecisionUrl, { method: 'POST', headers: { 'Content-Type': 'application/json',
    ...(reviewDecisionToken ? { Authorization: 'Bearer ' + reviewDecisionToken } : {}) },
    body: JSON.stringify({ phase, assignment, verdict }), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('External review policy failed (' + response.status + ')');
  return response.json();
};
const configOptions = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-3.8-flash-low',
  options: [{ value: 'gemini-3.8-flash-low', name: 'Local review fixture' }] }];
let nextMcpId = 0;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const mcp = async (server, method, params) => {
  const response = await fetch(server.url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...Object.fromEntries((server.headers || []).map((header) => [header.name, header.value])) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++nextMcpId, method, params }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Native MCP transport rejected (' + response.status + ')');
  const message = await response.json();
  if (message.error || message.result?.isError) throw new Error('Native MCP operation failed: ' + JSON.stringify(message.error || message.result));
  return message.result;
};
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  try {
    let result;
    switch (message.method) {
      case 'initialize':
        result = { protocolVersion: 1, agentInfo: { name: 'native-review-fixture', version: '1.0.0' },
          agentCapabilities: { mcpCapabilities: { http: true, sse: false }, promptCapabilities: {} }, authMethods: [] };
        break;
      case 'session/new': {
        const sessionId = randomUUID();
        const server = message.params.mcpServers?.find((candidate) => /^paperclip[_-]review$/.test(candidate.name));
        if (!server || server.type !== 'http') throw new Error('Expected authenticated adapter-owned review MCP server');
        sessions.set(sessionId, server);
        result = { sessionId, configOptions, models: { currentModelId: 'gemini-3.8-flash-low',
          availableModels: [{ modelId: 'gemini-3.8-flash-low', name: 'Local review fixture' }] } };
        break;
      }
      case 'session/set_model': case 'session/set_mode': result = {}; break;
      case 'session/set_config_option':
        if (message.params.configId !== 'model' || message.params.value !== 'gemini-3.8-flash-low') throw new Error('Unsupported model configuration');
        result = { configOptions }; break;
      case 'session/prompt': {
        const server = sessions.get(message.params.sessionId);
        if (!server) throw new Error('Unknown ACP session');
        await mcp(server, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'acp-fixture', version: '1.0.0' } });
        const assigned = await mcp(server, 'tools/call', { name: 'get_current_native_review_assignment', arguments: {} });
        const assignment = assigned.structuredContent;
        const controlled = reviewDecisionUrl && assignment?.kind === 'pull_request';
        const decision = controlled ? await reviewPolicy('before', assignment) : { verdict: 'approve' };
        const receipt = await mcp(server, 'tools/call', { name: 'submit_native_review_verdict', arguments: decision });
        if (controlled) await reviewPolicy('after', assignment, decision.verdict);
        send({ method: 'session/update', params: { sessionId: message.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(receipt) } } } });
        result = { stopReason: 'end_turn' };
        break;
      }
      default: send({ id: message.id, error: { code: -32601, message: 'Unsupported ACP method' } }); return;
    }
    send({ id: message.id, result });
  } catch (error) {
    send({ id: message.id, error: { code: -32000, message: error.message } });
  }
});
`, { mode: 0o700 });
  await chmod(serverPath, 0o700);
  return { serverPath };
}
