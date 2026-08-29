import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const InvariantRuleSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
  pattern: z.string().min(1), // Regex pattern string
  message: z.string().min(1),
  fileExtensions: z.array(z.string()).optional(),
});

export type InvariantRule = z.infer<typeof InvariantRuleSchema>;

export interface InvariantViolation {
  readonly ruleId: string;
  readonly severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  readonly message: string;
  readonly matchedPattern: string;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
}

export interface InvariantCheckResult {
  readonly isValid: boolean;
  readonly violations: readonly InvariantViolation[];
}

/**
 * Universal, language-agnostic clean-code invariants applied to all projects by default.
 */
export const UNIVERSAL_DEFAULT_RULES: readonly InvariantRule[] = Object.freeze([
  {
    id: "NO_GIT_CONFLICT_MARKERS",
    severity: "CRITICAL",
    pattern: "^(<<<<<<<|=======|>>>>>>>)(?:\\s|$)",
    message: "Unresolved git merge conflict markers found in source code.",
  },
  {
    id: "NO_ACCIDENTAL_PRIVATE_KEY_STRINGS",
    severity: "CRITICAL",
    pattern: "-----BEGIN (?:RSA|OPENSSH|EC|DSA|PGP)? PRIVATE KEY-----",
    message: "Potential plaintext private key embedded in source code.",
  },
]);

/**
 * Discovers and loads project-specific invariant rules from workspace configuration.
 */
export function loadProjectInvariants(workspacePath?: string, customRules?: readonly InvariantRule[]): InvariantRule[] {
  const rules: InvariantRule[] = [...UNIVERSAL_DEFAULT_RULES];

  if (customRules && Array.isArray(customRules)) {
    rules.push(...customRules);
  }

  if (workspacePath) {
    const candidatePaths = [
      path.join(workspacePath, ".paperclip", "invariants.json"),
      path.join(workspacePath, ".agents", "invariants.json"),
      path.join(workspacePath, ".invariants.json"),
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        try {
          const raw = fs.readFileSync(p, "utf-8");
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            for (const r of parsed) {
              const rule = InvariantRuleSchema.safeParse(r);
              if (rule.success) {
                rules.push(rule.data);
              }
            }
          }
        } catch {
          // ignore malformed config files
        }
      }
    }
  }

  return rules;
}

/**
 * Validates source code or git patches against declarative project invariant rules.
 */
export function checkCodeInvariants(
  code: string,
  fileName?: string,
  rules: readonly InvariantRule[] = UNIVERSAL_DEFAULT_RULES
): InvariantCheckResult {
  const violations: InvariantViolation[] = [];
  const fileExt = fileName ? path.extname(fileName).toLowerCase() : undefined;

  for (const rule of rules) {
    // If file extensions are specified, filter out non-matching files
    if (rule.fileExtensions && rule.fileExtensions.length > 0 && fileExt) {
      const matchesExt = rule.fileExtensions.some((ext) =>
        ext.startsWith(".") ? ext.toLowerCase() === fileExt : `.${ext.toLowerCase()}` === fileExt
      );
      if (!matchesExt) continue;
    }

    try {
      const regex = new RegExp(rule.pattern, "m");
      const match = code.match(regex);
      if (match) {
        violations.push(
          Object.freeze({
            ruleId: rule.id,
            severity: rule.severity,
            message: rule.message,
            matchedPattern: match[0],
            file: fileName,
          })
        );
      }
    } catch {
      // Invalid regex pattern
    }
  }

  return Object.freeze({
    isValid: violations.length === 0,
    violations: Object.freeze(violations),
  });
}
