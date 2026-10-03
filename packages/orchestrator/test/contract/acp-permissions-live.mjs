/** Real host + built external ACP adapter: observe permission decisions at the provider boundary. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDisposableHost } from "./disposable-host.mjs";
import { resolveContractHost } from "./host-installation.mjs";

const installation = resolveContractHost();
const root = await mkdtemp(path.join(tmpdir(), "paperclip-acp-permissions-"));
const report = { version: installation.version, safe: false, decisions: [] };
const token = randomUUID();
let host;
const outcomes = new Map();
const api = async (route, method = "GET", body) => {
  const r = await fetch(`${host.url}/api${route}`, { method, headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12_000) });
  assert.ok(r.ok, `${method} ${route}: ${r.status}`); return r.json();
};
const until = async (label, probe) => {
  const end = Date.now() + 45_000;
  while (Date.now() < end) { const value = await probe(); if (value) return value; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`Timed out waiting for ${label}`);
};
const recorder = createServer(async (request, response) => {
  try {
    assert.equal(request.headers["x-probe-token"], token);
    let text = ""; for await (const chunk of request) text += chunk;
    const outcome = JSON.parse(text);
    const r = await fetch(`${host.url}/api/heartbeat-runs/${outcome.runId}`, {
      headers: { authorization: request.headers.authorization }, signal: AbortSignal.timeout(12_000) });
    assert.equal(r.status, 200);
    const run = await r.json(); assert.equal(run.agentId, outcome.agentId); assert.equal(run.status, "running");
    assert.ok(!outcomes.has(outcome.agentId), "provider permission probe must run once per agent");
    outcomes.set(outcome.agentId, outcome); response.end("recorded");
  } catch { response.writeHead(403); response.end(); }
});
await new Promise((r) => recorder.listen(0, "127.0.0.1", r));
const probe = createServer(); await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port; await new Promise((r) => probe.close(r));
const providerPath = path.join(root, "agy_acp_server.par");
await writeFile(providerPath, `#!/usr/bin/env node
const readline = require('node:readline');
const pending = new Map(); let id = 100;
const send = m => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
const ask = kind => new Promise((resolve,reject) => {
  const requestId = ++id; const timer = setTimeout(() => reject(Error('ACP permission response missing')),10000);
  pending.set(requestId, m => {clearTimeout(timer);resolve(m.result?.outcome);});
  send({id:requestId,method:'session/request_permission',params:{sessionId:'permission-session',
    toolCall:{toolCallId:'probe-'+kind,title:kind==='read'?'Read task file':'Write task file',kind,status:'pending',content:[],locations:[]},
    options:[{optionId:'allow-once',kind:'allow_once',name:'Allow once'},{optionId:'reject-once',kind:'reject_once',name:'Reject once'}]}});
});
readline.createInterface({input:process.stdin}).on('line',async line => {
  const m = JSON.parse(line); if (!m.method) {pending.get(m.id)?.(m);pending.delete(m.id);return;}
  if (m.id===undefined) return;
  try {
    let result;
    if(m.method==='initialize') result={protocolVersion:1,agentInfo:{name:'permission-probe',version:'1'},agentCapabilities:{},authMethods:[]};
    else if(m.method==='session/new') result={sessionId:'permission-session'};
    else if(['session/set_model','session/set_mode','session/set_config_option'].includes(m.method)) result={};
    else if(m.method==='session/prompt') {
      const decisions={read:await ask('read'),write:await ask('edit'),runId:process.env.PAPERCLIP_RUN_ID,agentId:process.env.PAPERCLIP_AGENT_ID};
      const r=await fetch(${JSON.stringify(`http://127.0.0.1:${recorder.address().port}`)},{method:'POST',headers:{'content-type':'application/json','x-probe-token':${JSON.stringify(token)},authorization:'Bearer '+process.env.PAPERCLIP_API_KEY},body:JSON.stringify(decisions)});
      if(!r.ok) throw Error('Permission receipt attribution failed');
      const headers={authorization:'Bearer '+process.env.PAPERCLIP_API_KEY,'x-paperclip-run-id':process.env.PAPERCLIP_RUN_ID,'content-type':'application/json'};
      const nativeRun=await fetch(process.env.PAPERCLIP_API_URL+'/api/heartbeat-runs/'+process.env.PAPERCLIP_RUN_ID,{headers}).then(r=>r.json());
      const comment=await fetch(process.env.PAPERCLIP_API_URL+'/api/issues/'+nativeRun.contextSnapshot.issueId+'/comments',
        {method:'POST',headers,body:JSON.stringify({body:'Observed the provider permission policy for this bounded test task.'})});
      if(!comment.ok) throw Error('Permission worker status comment failed'); result={stopReason:'end_turn'};
    } else throw Error('Unsupported probe method '+m.method);
    send({id:m.id,result});
  } catch(e) {send({id:m.id,error:{code:-32000,message:e.message}});}
});
`, { mode: 0o700 });
host = createDisposableHost({ root, command: installation.command, args: [...installation.args, "onboard", "--config", path.join(root, "home/config.json"),
  "--data-dir", path.join(root, "home"), "--bind", "loopback", "--yes", "--no-install-service"], port,
  environment: { PAPERCLIP_API_URL: `http://127.0.0.1:${port}` }, readinessTimeoutMs: 60_000 });
try {
  await host.start();
  const packagePath = fileURLToPath(new URL("../../../antigravity", import.meta.url));
  await api("/adapters/install", "POST", { packageName: packagePath, isLocalPath: true });
  const company = await api("/companies", "POST", { name: "ACP permission upgrade qualification" });
  for (const permissionMode of ["approve-reads", "read-only", "prompt-on-write", "approve-all"]) {
    const agent = await api(`/companies/${company.id}/agents`, "POST", { name: `ACP ${permissionMode}`, role: "engineer", status: "idle", adapterType: "antigravity",
      adapterConfig: { serverPath: providerPath, permissionMode, cwd: root, timeoutSec: 30 },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    const issue = await api(`/companies/${company.id}/issues`, "POST", { title: `Observe ${permissionMode} provider permissions`, status: "todo" });
    await api(`/issues/${issue.id}`, "PATCH", { status: "in_progress", assigneeAgentId: agent.id });
    const outcome = await until("authenticated provider permission receipt", () => outcomes.get(agent.id));
    report.decisions.push({ permissionMode, ...outcome });
    assert.equal(outcome.read.optionId, "allow-once", "explicit restrictive mode must retain read access");
    assert.equal(outcome.write.optionId, permissionMode === "approve-all" ? "allow-once" : "reject-once",
      `permission mode ${permissionMode} must not silently allow provider writes`);
    const settled = await until("permission worker settles", async () => {
      const run = await api(`/heartbeat-runs/${outcome.runId}`); return run.finishedAt ? run : null;
    });
    assert.equal(settled.status, "succeeded");
  }
  report.safe = true;
  console.log("ACP_PERMISSIONS_CONTRACT", JSON.stringify(report));
} finally {
  try {
    await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    if (process.env.CONTRACT_REPORT_DIR) {
      await mkdir(process.env.CONTRACT_REPORT_DIR, { recursive: true });
      await writeFile(path.join(process.env.CONTRACT_REPORT_DIR, "acp-permissions.json"), JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
    }
    console.log(`ACP permission evidence: ${root}`);
  } finally {
    await host.stop(); recorder.closeAllConnections(); await new Promise((r) => recorder.close(r));
  }
}
