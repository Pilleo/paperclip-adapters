import { describe, expect, it } from "vitest";
import { evaluateScopeConformity } from "../src/scope-conformity.js";

describe("scope conformity decision table", () => {
  it.each([
    {
      desc: "exact file match",
      declaredTargetFiles: ["src/Foo.kt"],
      declaredTargetSymbols: ["Foo#bar"],
      modifiedFiles: ["src/Foo.kt"],
      rawDiff: "fun bar()",
      conformant: true,
    },
    {
      desc: "unplanned extra file",
      declaredTargetFiles: ["src/Foo.kt"],
      declaredTargetSymbols: [],
      modifiedFiles: ["src/Foo.kt", "README.md"],
      rawDiff: "",
      conformant: false,
    },
    {
      desc: "missing declared file",
      declaredTargetFiles: ["src/Foo.kt", "src/Bar.kt"],
      declaredTargetSymbols: [],
      modifiedFiles: ["src/Foo.kt"],
      rawDiff: "",
      conformant: false,
    },
    {
      desc: "open scope when no plan files",
      declaredTargetFiles: [],
      declaredTargetSymbols: [],
      modifiedFiles: ["a.ts", "b.ts"],
      rawDiff: "",
      conformant: true,
    },
    {
      desc: "docs-only extra is still drift when plan named sources",
      declaredTargetFiles: ["src/Foo.kt"],
      declaredTargetSymbols: [],
      modifiedFiles: ["src/Foo.kt", "docs/note.md"],
      rawDiff: "",
      conformant: false,
    },
    {
      desc: "empty diff does not fail symbols (gh unavailable)",
      declaredTargetFiles: ["src/Foo.kt"],
      declaredTargetSymbols: ["Foo#bar"],
      modifiedFiles: ["src/Foo.kt"],
      rawDiff: "",
      conformant: true,
    },
    {
      desc: "declared symbol missing from patch is drift",
      declaredTargetFiles: ["src/Foo.kt"],
      declaredTargetSymbols: ["Foo#bar"],
      modifiedFiles: ["src/Foo.kt"],
      rawDiff: "fun unrelated()",
      conformant: false,
    },
  ])("$desc", ({ declaredTargetFiles, declaredTargetSymbols, modifiedFiles, rawDiff, conformant }) => {
    const report = evaluateScopeConformity({
      declaredTargetFiles,
      declaredTargetSymbols,
      modifiedFiles,
      rawDiff,
    });
    expect(report.isConformant).toBe(conformant);
  });
});
