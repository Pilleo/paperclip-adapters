import { describe, it, expect } from "vitest";
import { outlineFileStructure, extractFailureContextWindow } from "../src/code-investigation.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Native Token-Efficient Code Investigation Toolkit", () => {
  it("extracts a complete failure context window without losing stack traces or cause chains", () => {
    const rawLog = `
[INFO] Running test suite...
[INFO] Pre-test initialization complete.
> Task :enforcer:test

io.mazewall.seccomp.BpfFilterPropertyTest > testLinearScanOrdering() FAILED
    java.lang.AssertionError: Expected SECCOMP_RET_ERRNO with EPERM, but got EACCES
        at io.mazewall.seccomp.BpfFilterPropertyTest.testLinearScanOrdering(BpfFilterPropertyTest.kt:142)
        at org.junit.jupiter.api.AssertionUtils.fail(AssertionUtils.java:55)
    Caused by: io.mazewall.enforcer.KernelSeccompException: Bad filter return code
        at io.mazewall.seccomp.PureJavaBpfEngine.install(PureJavaBpfEngine.kt:89)
        ... 500 lines of gradle internals ...
`;

    const window = extractFailureContextWindow(rawLog, 20);
    expect(window.failedTestName).toContain("BpfFilterPropertyTest");
    expect(window.failureContext).toContain("java.lang.AssertionError");
    expect(window.failureContext).toContain("Caused by: io.mazewall.enforcer.KernelSeccompException");
    expect(window.failureContext).toContain("BpfFilterPropertyTest.kt:142");
    expect(window.failureContext).toContain("PureJavaBpfEngine.kt:89");
  });

  it("generates native TypeScript file outline across languages without external binaries", () => {
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

    const outline = outlineFileStructure(testFile);
    expect(outline.fileName).toBe("SampleFile.kt");
    expect(outline.classCount).toBe(1);
    expect(outline.methodCount).toBe(2);
    expect(outline.outlineText).toContain("[TYPE] L3: class SampleFile");
    expect(outline.outlineText).toContain("[METHOD] L4: private fun internalHelper()");
    expect(outline.outlineText).toContain("[METHOD] L8: public fun executeTask(param: String): Boolean");
  });
});
