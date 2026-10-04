import { describe, expect, it } from "vitest";
import { bootstrapQuestionChild, questionBootstrapDescription, parseQuestionBootstrap, observeQuestionChild } from "../src/server/question-bootstrap.js";

const identity = { version: 1 as const, companyId: "company", parentIssueId: "parent", sessionId: "original-session",
  activityId: "question-activity", reviewerAgentId: "reviewer", bootstrapAgentId: "jules", question: "Should I proceed?", generation: 0 };

function fixture(sourceIssueId = "child") {
  const writes: Array<{ path: string; body: unknown }> = [];
  const child = { id: "child", companyId: "company", parentId: "parent", createdByAgentId: "jules",
    assigneeAgentId: "jules", status: "in_progress", description: questionBootstrapDescription(identity), executionBlocker: null };
  const cards: unknown[] = [];
  const api = {
    get: async (path: string): Promise<unknown> => {
      if (path === "/issues/child") return child;
      if (path === "/issues/parent") return { id: "parent", companyId: "company", assigneeAgentId: "jules", status: "blocked", description: "Create one PR", executionBlocker: null };
      if (path === "/heartbeat-runs/bootstrap-run") return { id: "bootstrap-run", companyId: "company", agentId: "jules", status: "running", contextSnapshot: { issueId: sourceIssueId } };
      if (path === "/issues/child/interactions") return cards;
      if (path === "/agents/reviewer") return { id: "reviewer", companyId: "company", status: "idle" };
      throw new Error(`Unexpected GET ${path}`);
    },
    post: async (path: string, body: any) => {
      writes.push({ path, body }); const card = { ...body, id: "question-card", status: "pending", sourceRunId: "bootstrap-run", companyId: "company", issueId: "child" };
      cards.push(card); return card;
    },
    patch: async (path: string, body: any) => { writes.push({ path, body }); Object.assign(child, body); return child; },
  };
  return { api, writes, child };
}

describe("native question bootstrap", () => {
  it("round-trips multiline questions after Paperclip normalizes escaped description newlines", () => {
    const multiline = { ...identity, question: "The revised plan is ready.\n\nAwaiting approval." };
    const description = questionBootstrapDescription(multiline).replaceAll("\\n", "\n");
    expect(parseQuestionBootstrap(description)).toEqual(multiline);
  });
  it("reads an existing legacy marker whose quoted question was normalized to literal newlines", () => {
    const multiline = { ...identity, question: "The revised plan is ready.\n\nAwaiting approval." };
    const old = "<!-- jules-question-bootstrap:v1\n" + JSON.stringify(multiline).replaceAll("\\n", "\n") + "\n-->";
    expect(parseQuestionBootstrap(old)).toEqual(multiline);
  });

  it("consolidates only identical deferred children with no native execution or card history", async () => {
    for (const executed of [false, true]) {
      const writes: Array<{path:string;body:any}> = [];
      const children = ["duplicate-a","duplicate-b"].map(id=>({id,companyId:"company",parentId:"parent",createdByAgentId:"jules",
        assigneeAgentId:"jules",status:"backlog",description:questionBootstrapDescription(identity),executionBlocker:null}));
      const api = {
        get: async (path:string):Promise<unknown> => {
          if(path==="/issues/parent")return {id:"parent",companyId:"company",assigneeAgentId:"jules",status:"blocked",executionBlocker:null};
          if(path.startsWith("/companies/"))return children;
          if(path.endsWith("/interactions"))return [];
          if(path.endsWith("/runs"))return executed&&path.includes("duplicate-b")?[{contextIssueId:"duplicate-b",status:"running"}]:[];
          if(path==="/agents/reviewer")return {status:"idle"};
          return children.find(c=>path==="/issues/"+c.id);
        },
        post:async()=>{throw Error("An existing generation must not be recreated");},
        patch:async(path:string,body:any)=>{writes.push({path,body});return body;},
      };
      if(executed){await expect(observeQuestionChild({identity,api})).rejects.toThrow(/execution or decision history/);expect(writes).toEqual([]);}
      else {expect(await observeQuestionChild({identity,api})).toMatchObject({childId:"duplicate-a"});expect(writes).toContainEqual({path:"/issues/duplicate-b",body:{status:"cancelled"}});}
    }
  });
  it("refuses a borrowed parent run before creating a reviewer question", async () => {
    const f = fixture("parent");
    await expect(bootstrapQuestionChild({ identity, childId: "child", runId: "bootstrap-run", agentId: "jules", api: f.api })).rejects.toThrow(/child-scoped/);
    expect(f.writes).toEqual([]);
  });

  it("creates the question on its own child run and parks it before reviewer handoff", async () => {
    const f = fixture();
    const result = await bootstrapQuestionChild({ identity, childId: "child", runId: "bootstrap-run", agentId: "jules", api: f.api });
    expect(result.cardId).toBe("question-card");
    expect(f.child.status).toBe("backlog");
    expect(f.child.assigneeAgentId).toBe("jules");
    const posted = f.writes.find(w => w.path.endsWith("/interactions"))?.body as any;
    expect(posted.addresseeAgentId).toBe("reviewer");
    expect(posted.payload.questions.every((q: any) => q.allowOther === false)).toBe(true);
  });

  it("creates only a deferred bootstrap child during a parent poll", async () => {
    const writes: Array<{ path: string; body: any }> = [];
    const api = {
      get: async (path: string) => {
        if (path === "/issues/parent") return { id: "parent", companyId: "company", assigneeAgentId: "jules", status: "blocked", executionBlocker: null };
        if (path.startsWith("/companies/")) return [];
        throw new Error(`Unexpected GET ${path}`);
      },
      post: async (path: string, body: any) => { writes.push({ path, body }); return { ...body, id: "new-child", companyId: "company", parentId: "parent", createdByAgentId: "jules" }; },
      patch: async () => { throw new Error("Activation must follow a durable child checkpoint"); },
    };
    expect(await observeQuestionChild({ identity, api })).toMatchObject({ kind: "waiting", childId: "new-child" });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toMatchObject({ status: "backlog", assigneeAgentId: "jules", blockParentUntilDone: false });
  });

  it("returns the exact pending card with a failed reviewer so recovery can retire it before creating another", async () => {
    const f = fixture();
    await bootstrapQuestionChild({ identity, childId: "child", runId: "bootstrap-run", agentId: "jules", api: f.api });
    f.child.assigneeAgentId = "reviewer"; f.child.status = "blocked";
    const get = f.api.get;
    f.api.get = async path => path === "/issues/child/runs"
      ? [{ runId: "failed-reviewer", agentId: "reviewer", status: "failed", contextIssueId: "child" }]
      : get(path);
    expect(await observeQuestionChild({ identity, childId: "child", api: f.api })).toMatchObject({
      kind: "failed", cardId: "question-card", runId: "failed-reviewer", childId: "child",
    });
  });
});
