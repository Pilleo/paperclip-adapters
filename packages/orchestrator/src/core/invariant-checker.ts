export interface InvariantViolation {
  readonly ruleId: string;
  readonly severity: "CRITICAL" | "HIGH" | "MEDIUM";
  readonly message: string;
  readonly matchedPattern: string;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
}

export interface InvariantCheckResult {
  readonly isValid: boolean;
  readonly violations: readonly InvariantViolation[];
}

const BANNED_PATTERNS: Array<{
  id: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  pattern: RegExp;
  message: string;
}> = [
  {
    id: "NO_SILENT_EPERM_BYPASS",
    severity: "CRITICAL",
    pattern: /catch\s*\([^)]*(?:EPERM|EACCES|ErrnoException)[^)]*\)\s*\{(?:(?!\bthrow\b|\brethrow\b|\bexitProcess\b|\berror\b).)*\}/s,
    message: "Forbidden silent bypass: EPERM or EACCES caught without rethrow or crash.",
  },
  {
    id: "NO_TSYNC_WITH_NEW_LISTENER",
    severity: "CRITICAL",
    pattern: /SECCOMP_FILTER_FLAG_TSYNC\s*\|\s*SECCOMP_FILTER_FLAG_NEW_LISTENER|SECCOMP_FILTER_FLAG_NEW_LISTENER\s*\|\s*SECCOMP_FILTER_FLAG_TSYNC/,
    message: "Forbidden seccomp flag combination: SECCOMP_FILTER_FLAG_TSYNC cannot be combined with SECCOMP_FILTER_FLAG_NEW_LISTENER.",
  },
  {
    id: "NO_JAVA_LONG_FOR_SOCK_FILTER_FIELDS",
    severity: "HIGH",
    pattern: /JAVA_LONG\s*\/\/\s*(?:code|jt|jf|k)|(?:code|jt|jf|k)\s*=\s*JAVA_LONG/,
    message: "Forbidden FFM layout: sock_filter 32-bit struct fields cannot use JAVA_LONG.",
  },
  {
    id: "NO_BLOCKING_JVM_COORDINATION_SYSCALLS",
    severity: "CRITICAL",
    pattern: /(?:DENY|KILL|ERRNO)\s*\(\s*Syscall\.(?:FUTEX|RESTART_SYSCALL|SIGALTSTACK|RT_SIGRETURN|SCHED_YIELD)\s*\)/i,
    message: "Forbidden sandbox policy: JVM coordination syscalls (futex, restart_syscall, sigaltstack, rt_sigreturn, sched_yield) must never be blocked.",
  },
];

/**
 * Validates code changes or patches against Mazewall kernel and security invariants.
 */
export function checkCodeInvariants(code: string, fileName?: string): InvariantCheckResult {
  const violations: InvariantViolation[] = [];

  for (const rule of BANNED_PATTERNS) {
    const match = code.match(rule.pattern);
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
  }

  return Object.freeze({
    isValid: violations.length === 0,
    violations: Object.freeze(violations),
  });
}
