import { describe, it, expect } from "vitest";
import {
  parseGitDiffIntoFiles,
  prioritizeAndCompressDiff,
  calculatePriorityScore,
} from "../src/core/smart-diff-synthesizer.js";

describe("Smart Diff Synthesizer (Project-Agnostic)", () => {
  const sampleGitDiff = `diff --git a/src/test/DummyTest.ts b/src/test/DummyTest.ts
index 1111111..2222222 100644
--- a/src/test/DummyTest.ts
+++ b/src/test/DummyTest.ts
@@ -10,6 +10,12 @@
 class DummyTest {
+    testSomething() {
+        console.log("dummy")
+    }
 }
diff --git a/src/core/SecurityEngine.ts b/src/core/SecurityEngine.ts
index 3333333..4444444 100644
--- a/src/core/SecurityEngine.ts
+++ b/src/core/SecurityEngine.ts
@@ -50,6 +50,15 @@
-    insecureMethod() {
+    secureMethod() {
+        // Core production security logic
+    }
diff --git a/README.md b/README.md
index 5555555..6666666 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,4 @@
 # Readme
+# Update
`;

  it("parses raw git diff into structured file diff blocks", () => {
    const blocks = parseGitDiffIntoFiles(sampleGitDiff);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].filePath).toBe("src/test/DummyTest.ts");
    expect(blocks[1].filePath).toBe("src/core/SecurityEngine.ts");
    expect(blocks[2].filePath).toBe("README.md");
  });

  it("prioritizes declared target files and production code over tests and documentation", () => {
    const blocks = parseGitDiffIntoFiles(sampleGitDiff, {
      targetFiles: ["src/core/SecurityEngine.ts"],
      targetSymbols: ["secureMethod"],
    });

    const prioritized = prioritizeAndCompressDiff(blocks, {
      maxCharBudget: 500,
    });

    expect(prioritized.includedFiles).toContain("src/core/SecurityEngine.ts");
    expect(prioritized.formattedDiff).toContain("secureMethod");
    expect(prioritized.manifest).toContain("SecurityEngine.ts");
    expect(prioritized.manifest).toContain("DummyTest.ts");
    expect(prioritized.manifest).toContain("README.md");
  });

  it("calculates priority scores project-agnostically across any language or repo structure", () => {
    const prodScore = calculatePriorityScore("src/server/auth.go");
    const testScore = calculatePriorityScore("src/server/auth_test.go");
    const docScore = calculatePriorityScore("docs/architecture.md");
    const targetScore = calculatePriorityScore("src/server/auth.go", { targetFiles: ["src/server/auth.go"] });

    expect(prodScore).toBeGreaterThan(testScore);
    expect(testScore).toBeGreaterThan(docScore);
    expect(targetScore).toBeGreaterThan(prodScore);
  });
});
