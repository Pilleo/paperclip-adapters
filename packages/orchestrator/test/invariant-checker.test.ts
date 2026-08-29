import { describe, it, expect } from "vitest";
import { checkCodeInvariants } from "../src/core/invariant-checker.js";

describe("Mazewall Security & Invariant Checker", () => {
  describe.each([
    {
      name: "flags silent EPERM catch block without rethrow",
      code: `
try {
  linuxNative.seccomp(prog)
} catch (e: EPERM) {
  logger.warn("Seccomp failed, falling back")
}
`,
      shouldBeValid: false,
      expectedRuleId: "NO_SILENT_EPERM_BYPASS",
    },
    {
      name: "passes EPERM catch block that rethrows",
      code: `
try {
  linuxNative.seccomp(prog)
} catch (e: EPERM) {
  logger.error("Seccomp failed")
  throw ContainmentViolationException("Failed", e)
}
`,
      shouldBeValid: true,
      expectedRuleId: undefined,
    },
    {
      name: "flags combined TSYNC and NEW_LISTENER flags",
      code: `
val flags = SECCOMP_FILTER_FLAG_TSYNC | SECCOMP_FILTER_FLAG_NEW_LISTENER
linuxNative.seccomp(SECCOMP_SET_MODE_FILTER, flags, prog)
`,
      shouldBeValid: false,
      expectedRuleId: "NO_TSYNC_WITH_NEW_LISTENER",
    },
    {
      name: "flags blocking JVM coordination syscall (futex)",
      code: `
val policy = Policy.builder()
  .action(DENY(Syscall.FUTEX))
  .build()
`,
      shouldBeValid: false,
      expectedRuleId: "NO_BLOCKING_JVM_COORDINATION_SYSCALLS",
    },
    {
      name: "passes clean policy allowing JVM coordination syscalls",
      code: `
val policy = Policy.builder()
  .action(ALLOW(Syscall.FUTEX))
  .action(DENY(Syscall.EXECVE))
  .build()
`,
      shouldBeValid: true,
      expectedRuleId: undefined,
    },
  ])("Rule: $name", ({ code, shouldBeValid, expectedRuleId }) => {
    it(`evaluates code correctly (valid=${shouldBeValid})`, () => {
      const result = checkCodeInvariants(code, "Sample.kt");
      expect(result.isValid).toBe(shouldBeValid);
      if (expectedRuleId) {
        expect(result.violations.some((v) => v.ruleId === expectedRuleId)).toBe(true);
      }
    });
  });
});
