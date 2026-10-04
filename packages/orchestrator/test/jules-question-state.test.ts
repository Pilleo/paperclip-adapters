import { describe, expect, it } from "vitest";
import { coordinateJulesQuestionChild, hasPendingJulesQuestion } from "../src/core/jules-question-state.js";
import { questionBootstrapDescription } from "@pilleo/paperclip-adapter-common";

describe("blocked native question ownership", () => {
  it("advances a known standalone helper without enumerating the unrelated company inventory", async () => {
    const identity={version:1 as const,companyId:"company",parentIssueId:"parent",sessionId:"session",activityId:"activity",
      reviewerAgentId:"reviewer",bootstrapAgentId:"jules",question:"Should I continue?",generation:0};
    const description=questionBootstrapDescription(identity);
    const writes:unknown[]=[];
    const api={get:async(path:string):Promise<unknown>=>{
      if(path==="/issues/parent/interactions")return [{id:"parent-card",kind:"ask_user_questions",status:"pending",idempotencyKey:"jules:agent-adjudication:parent:session:activity:presentation:v2"}];
      if(path==="/issues/parent")return {id:"parent",companyId:"company",assigneeAgentId:"jules",status:"blocked",executionBlocker:null};
      if(path==="/issues/standalone")return {id:"standalone",companyId:"company",parentId:null,createdByAgentId:"jules",assigneeAgentId:"jules",status:"backlog",description,executionBlocker:null};
      if(path.endsWith("/interactions")||path.endsWith("/runs"))return [];
      if(path==="/agents/reviewer")return {status:"idle"};
      throw Error("Known standalone identity must not depend on company-wide search: "+path);
    },post:async()=>{throw Error("A known helper must not be recreated");},patch:async(path:string,body:unknown)=>{writes.push({path,body});return body;}};
    expect(await coordinateJulesQuestionChild({childId:"standalone",description,api})).toMatchObject({kind:"waiting",parentId:"parent"});
    expect(writes).toHaveLength(1);
  });
  it("preserves the Jules wait while its direct-answer or human-escalation card is pending", () => {
    for (const kind of ["agent-adjudication", "human-escalation", "user-feedback"]) {
      expect(hasPendingJulesQuestion("parent", [{ kind: "ask_user_questions", status: "pending", idempotencyKey: `jules:${kind}:parent:original:activity:presentation:v2` }])).toBe(true);
    }
  });
  it("does not claim unrelated or already answered cards", () => {
    expect(hasPendingJulesQuestion("parent", [{ kind: "ask_user_questions", status: "pending", idempotencyKey: "jules:human-escalation:different:session:activity" }])).toBe(false);
    expect(hasPendingJulesQuestion("parent", [{ kind: "ask_user_questions", status: "answered", idempotencyKey: "jules:human-escalation:parent:session:activity" }])).toBe(false);
  });
});
