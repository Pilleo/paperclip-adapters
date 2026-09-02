import { describe, expect, it } from "vitest";
import { parseQuestionAdjudication } from "../src/server/question-adjudication.js";

describe("question adjudication protocol", () => {
  it("accepts only a typed reviewer answer", () => {
    expect(parseQuestionAdjudication('{"kind":"ANSWER","answer":"Use the existing public API."}'))
      .toEqual({ kind: "ANSWER", answer: "Use the existing public API." });
  });

  it("accepts only a typed human escalation", () => {
    expect(parseQuestionAdjudication('{"kind":"ESCALATE","reason":"The product preference is not specified."}'))
      .toEqual({ kind: "ESCALATE", reason: "The product preference is not specified." });
  });

  it("does not infer a decision from reviewer prose or markdown", () => {
    expect(parseQuestionAdjudication("I think Jules should continue.")).toBeNull();
    expect(parseQuestionAdjudication('```json\n{"kind":"ANSWER","answer":"continue"}\n```')).toBeNull();
  });
});
