import { describe, it, expect } from "vitest";
import {
  checkCodeInvariants,
  loadProjectInvariants,
  UNIVERSAL_DEFAULT_RULES,
  InvariantRule,
} from "../src/core/invariant-checker.js";

describe("Declarative Pluggable Invariant Engine", () => {
  describe("Universal Default Invariants", () => {
    it.each([
      {
        name: "detects git merge conflict markers",
        code: `
function add(a, b) {
<<<<<<< HEAD
  return a + b;
=======
  return b + a;
>>>>>>> master
}
`,
        fileName: "src/calc.ts",
        expectedRule: "NO_GIT_CONFLICT_MARKERS",
      },
      {
        name: "detects raw private key strings",
        code: `
const secretKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----";
`,
        fileName: "config/auth.js",
        expectedRule: "NO_ACCIDENTAL_PRIVATE_KEY_STRINGS",
      },
    ])("Rule: $name", ({ code, fileName, expectedRule }) => {
      const res = checkCodeInvariants(code, fileName, UNIVERSAL_DEFAULT_RULES);
      expect(res.isValid).toBe(false);
      expect(res.violations.some((v) => v.ruleId === expectedRule)).toBe(true);
    });

    it("passes clean code with zero violations", () => {
      const res = checkCodeInvariants("export const add = (a: number, b: number) => a + b;", "src/calc.ts");
      expect(res.isValid).toBe(true);
      expect(res.violations).toHaveLength(0);
    });
  });

  describe("Custom Project-Specific Invariants", () => {
    const customProjectRules: InvariantRule[] = [
      {
        id: "NO_UNWRAPPED_PANIC_IN_RUST",
        severity: "HIGH",
        pattern: "\\bunwrap\\(\\)",
        message: "Production Rust code must use explicit Result handling rather than .unwrap().",
        fileExtensions: [".rs"],
      },
      {
        id: "NO_DANGEROUS_HTML_IN_REACT",
        severity: "CRITICAL",
        pattern: "dangerouslySetInnerHTML",
        message: "Direct DOM injection via dangerouslySetInnerHTML is prohibited.",
        fileExtensions: [".tsx", ".jsx"],
      },
    ];

    it("evaluates custom Rust rule only on .rs files", () => {
      const rustBad = checkCodeInvariants("let val = item.unwrap();", "src/lib.rs", customProjectRules);
      expect(rustBad.isValid).toBe(false);
      expect(rustBad.violations[0]?.ruleId).toBe("NO_UNWRAPPED_PANIC_IN_RUST");

      // Ignored for non-rust files
      const tsOk = checkCodeInvariants("const val = item.unwrap();", "src/lib.ts", customProjectRules);
      expect(tsOk.isValid).toBe(true);
    });

    it("evaluates custom React rule on .tsx files", () => {
      const reactBad = checkCodeInvariants("<div dangerouslySetInnerHTML={{ __html: data }} />", "components/Post.tsx", customProjectRules);
      expect(reactBad.isValid).toBe(false);
      expect(reactBad.violations[0]?.ruleId).toBe("NO_DANGEROUS_HTML_IN_REACT");
    });
  });

  describe("loadProjectInvariants", () => {
    it("returns universal default rules when no workspace custom rules exist", () => {
      const rules = loadProjectInvariants();
      expect(rules.length).toBeGreaterThanOrEqual(UNIVERSAL_DEFAULT_RULES.length);
      expect(rules.some((r) => r.id === "NO_GIT_CONFLICT_MARKERS")).toBe(true);
    });
  });
});
