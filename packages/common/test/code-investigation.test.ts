import { describe, it, expect } from "vitest";
import { outlineFileStructure, compactLargeLogToEvidence } from "../src/code-investigation.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Token-Efficient Code Investigation Toolkit", () => {
  it("compacts massive test failure logs into a 3-line evidence packet", () => {
    const rawGiganticLog = `
> Task :enforcer:test

io.mazewall.seccomp.BpfFilterPropertyTest > testLinearScanOrdering() FAILED
    java.lang.AssertionError: Expected SECCOMP_RET_ERRNO with EPERM, but got EACCES
        at io.mazewall.seccomp.BpfFilterPropertyTest.testLinearScanOrdering(BpfFilterPropertyTest.kt:142)
        at org.junit.jupiter.api.AssertionUtils.fail(AssertionUtils.java:55)
        at org.junit.jupiter.api.AssertEquals.assertEquals(AssertEquals.java:182)
        at java.base/java.lang.reflect.Method.invoke(Method.java:580)
        at org.gradle.api.internal.tasks.testing.junit.JUnitTestClassExecuter.runTestClass(JUnitTestClassExecuter.java:112)
        ... 500 lines of gradle internals ...
`;

    const evidence = compactLargeLogToEvidence(rawGiganticLog);
    expect(evidence.failedTestName).toContain("BpfFilterPropertyTest");
    expect(evidence.errorType).toContain("java.lang.AssertionError");
    expect(evidence.errorLocation).toContain("BpfFilterPropertyTest.kt:142");
    expect(evidence.rootCauseSnippet).toContain("💥 Failing Test:");
    expect(evidence.rootCauseSnippet).toContain("🚨 Root Error:");
    expect(evidence.rootCauseSnippet).toContain("📍 Code Location:");
  });

  it("generates compact file outline without loading full tokens", async () => {
    const tmpDir = os.tmpdir();
    const testFile = path.join(tmpDir, "SampleFile.kt");
    fs.writeFileSync(
      testFile,
      `package io.mazewall

class SampleFile {
    private fun internalHelper() {
        // 50 lines of complex code
    }

    public fun executeTask(param: String): Boolean {
        // 100 lines of code
        return true
    }
}`
    );

    const outline = await outlineFileStructure(testFile);
    expect(outline.fileName).toBe("SampleFile.kt");
    expect(outline.classCount).toBe(1);
    expect(outline.methodCount).toBe(2);
    expect(outline.outlineText).toContain("[CLASS] L3: class SampleFile");
    expect(outline.outlineText).toContain("[METHOD] L4: private fun internalHelper()");
    expect(outline.outlineText).toContain("[METHOD] L8: public fun executeTask(param: String): Boolean");
  });
});
