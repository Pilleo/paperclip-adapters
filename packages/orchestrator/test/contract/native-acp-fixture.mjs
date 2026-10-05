import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

/** External ACP provider simulator; all verdict writes go through the real adapter-owned MCP bridge. */
export async function createNativeAcpFixture(root, { reviewDecisionUrl, reviewDecisionToken, finishPrReview = false, questionResponse, failFirstQuestionReview = false, omitPrVerdict = false } = {}) {
  const serverPath = path.join(root, "agy_acp_server.par");
  await writeFile(serverPath, `#!/usr/bin/env node
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const sessions = new Map();
const reviewDecisionUrl = ${JSON.stringify(reviewDecisionUrl ?? null)};
const reviewDecisionToken = ${JSON.stringify(reviewDecisionToken ?? null)};
const finishPrReview = ${JSON.stringify(finishPrReview)};
const questionResponse = ${JSON.stringify(questionResponse ?? null)};
const questionFailurePath = ${JSON.stringify(path.join(root, "question-failure-observed"))};
const failFirstQuestionReview = ${JSON.stringify(failFirstQuestionReview)};
const omitPrVerdict = ${JSON.stringify(omitPrVerdict)};
const nativeApi = async (route, method = 'GET', body) => {
  const env = process.env;
  if (!env.PAPERCLIP_API_KEY || !env.PAPERCLIP_RUN_ID || !env.PAPERCLIP_API_URL) throw new Error('Missing native reviewer runtime credentials');
  const response = await fetch(env.PAPERCLIP_API_URL + '/api' + route, { method,
    headers: { Authorization: 'Bearer ' + env.PAPERCLIP_API_KEY, 'X-Paperclip-Run-Id': env.PAPERCLIP_RUN_ID, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Native reviewer disposition failed (' + response.status + '): ' + await response.text());
  return response.json();
};
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
let nextPermissionId = 10000;
const permissionRequests = new Map();
const nativePermission = (sessionId, name) => new Promise((resolve, reject) => {
  const id = ++nextPermissionId;
  const timer = setTimeout(() => { permissionRequests.delete(id); reject(new Error('Native ACP permission response missing')); }, 10000);
  permissionRequests.set(id, message => {
    clearTimeout(timer);
    if (message.result?.outcome?.outcome === 'selected' && message.result.outcome.optionId === 'allow-once') resolve();
    else reject(new Error('Native ACP permission denied for ' + name));
  });
  send({ id, method: 'session/request_permission', params: { sessionId,
    toolCall: { toolCallId: 'native-' + id, title: 'paperclip_review_' + name, kind: 'other', status: 'pending' },
    options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject-once', kind: 'reject_once', name: 'Reject once' }] } });
});
const mcp = async (server, method, params) => {
  if (method === 'tools/call') await nativePermission(server.sessionId, params.name);
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
  if (!message.method) { permissionRequests.get(message.id)?.(message); permissionRequests.delete(message.id); return; }
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
        server.sessionId = sessionId;
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
        if (questionResponse) {
          const run = await nativeApi('/heartbeat-runs/' + process.env.PAPERCLIP_RUN_ID);
          const issueId = run.contextSnapshot.issueId;
          const cards = await nativeApi('/issues/' + issueId + '/interactions');
          const question = cards.find(c => c.kind === 'ask_user_questions' && c.status === 'pending' && c.addresseeAgentId === process.env.PAPERCLIP_AGENT_ID);
          if (question) {
            const source = await nativeApi('/heartbeat-runs/' + question.sourceRunId);
            if (source.contextSnapshot.issueId !== issueId) throw new Error('Question source must be child-scoped');
            if (failFirstQuestionReview && !fs.existsSync(questionFailurePath)) {
              fs.writeFileSync(questionFailurePath, process.env.PAPERCLIP_RUN_ID, {mode:0o600});
              throw new Error('Controlled question reviewer failure before typed decision');
            }
            const receipt = await mcp(server, 'tools/call', { name: 'submit_jules_question_decision', arguments: {decision:'answer',response:questionResponse} });
            await nativeApi('/issues/' + issueId, 'PATCH', {status:'done'});
            await nativeApi('/issues/' + issueId + '/comments', 'POST', {body:'Completed the native question decision through its addressed form.'});
            send({method:'session/update',params:{sessionId:message.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(receipt)}}}});
            result = {stopReason:'end_turn'}; break;
          }
        }
        const assigned = await mcp(server, 'tools/call', { name: 'get_current_native_review_assignment', arguments: {} });
        const assignment = assigned.structuredContent;
        if (assignment?.kind === 'pull_request') {
          if (assignment.artifact?.complete !== true || assignment.artifact.headSha !== assignment.headSha ||
              !Array.isArray(assignment.artifact.files) || typeof assignment.artifact.diff !== 'string') {
            throw new Error('Native PR review requires the complete immutable artifact through MCP');
          }
          if (omitPrVerdict) {
            send({ method: 'session/update', params: { sessionId: message.params.sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I approve this PR. Review complete.' } } } });
            result = { stopReason: 'end_turn' }; break;
          }
        }
        const controlled = reviewDecisionUrl && assignment?.kind === 'pull_request';
        const decision = controlled ? await reviewPolicy('before', assignment) : { verdict: 'approve' };
        const receipt = await mcp(server, 'tools/call', { name: 'submit_native_review_verdict', arguments: decision });
        if (finishPrReview && assignment?.kind === 'pull_request') {
          const run = await nativeApi('/heartbeat-runs/' + process.env.PAPERCLIP_RUN_ID);
          if (run.agentId !== process.env.PAPERCLIP_AGENT_ID) throw new Error('Review run identity mismatch');
          const issueId = run.contextSnapshot.issueId;
          const cards = await nativeApi('/issues/' + issueId + '/interactions');
          const card = cards.find((candidate) => candidate.id === assignment.interactionId);
          if (!card || card.status !== 'answered' || card.addresseeAgentId !== run.agentId || card.resolvedByRunId !== process.env.PAPERCLIP_RUN_ID) throw new Error('Native review completion requires the addressed verdict from this run');
          await nativeApi('/issues/' + issueId, 'PATCH', { status: 'done' });
        }
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
