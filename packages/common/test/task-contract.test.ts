import { describe, expect, it } from "vitest";
import { parseTaskContract } from "../src/task-contract.js";
import { evaluateScopeConformity } from "../src/scope-conformity.js";

describe("parseTaskContract", () => {
  it("recognizes canonical frontmatter with explicit scope", () => {
    expect(parseTaskContract(`---
target_files: ["src/increment.ts"]
target_symbols: ["increment"]
---
Implement the increment helper and its focused behavioral test.`)).toEqual({
      kind: "structured",
      requirements: "Implement the increment helper and its focused behavioral test.",
      targetFiles: ["src/increment.ts"],
      targetSymbols: ["increment"],
    });
  });

  it("keeps inline metadata-looking prose unstructured and literal", () => {
    const requirements = 'orchestrator_managed: true component: "core" target_files: ["canary-increment.js"]\n\nImplement the increment helper and its focused behavioral test.';

    expect(parseTaskContract(requirements)).toEqual({
      kind: "unstructured",
      requirements,
    });
  });

  it("keeps PR scope telemetry open when the task is unstructured", () => {
    const contract = parseTaskContract('target_files: ["not-frontmatter.ts"]\nImplement the helper and its test.');
    const report = evaluateScopeConformity({
      declaredTargetFiles: contract.kind === "structured" ? contract.targetFiles : [],
      declaredTargetSymbols: contract.kind === "structured" ? contract.targetSymbols : [],
      modifiedFiles: ["increment.js", "increment.test.js"],
    });

    expect(report.isConformant).toBe(true);
    expect(report.unplannedFiles).toEqual([]);
  });
});
