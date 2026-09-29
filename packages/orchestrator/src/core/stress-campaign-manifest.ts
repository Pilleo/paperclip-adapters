/** Declarative, provider-independent contracts for the disposable 20-PR run. */
export interface StressTask {
  readonly key: string;
  readonly predecessors: readonly string[];
  readonly implementationFile: string;
  readonly testFile: string;
  readonly exportName: string;
  readonly contract: string;
  readonly runKey: string;
}

interface Definition {
  readonly key: string;
  readonly predecessors: readonly string[];
  readonly name: string;
  readonly contract: (file: (key: string) => string) => string;
}

const DEFINITIONS: readonly Definition[] = [
  { key: "01", predecessors: [], name: "increment", contract: () => "Export increment(n) for finite integers, returning n + 1. Cover 2 -> 3, 0 -> 1, -1 -> 0 and TypeError for non-number, fractional and non-finite input." },
  { key: "02", predecessors: [], name: "cleanText", contract: () => "Export cleanText(value): trim the input string without changing internal spaces; throw TypeError for non-strings. Cover padded text, empty text and invalid input." },
  { key: "03", predecessors: [], name: "safeInt", contract: () => "Add the safeInt(value) CommonJS export to the shared numbers module. Accept only trimmed integer strings; return the finite integer or null for fractions, empty strings and invalid input. Preserve all other exports. Test 12, -2, 3.5 and garbage." },
  { key: "04", predecessors: [], name: "safeDecimal", contract: () => "Add the safeDecimal(value) CommonJS export to the shared numbers module. Accept only trimmed strings representing finite decimal numbers; return the number or null for empty strings, Infinity and invalid input. Preserve all other exports. Test 3.5, -1.25 and garbage." },
  { key: "05", predecessors: [], name: "uniqueSorted", contract: () => "Export uniqueSorted(values): return a new ascending deduplicated array of finite numbers; reject non-arrays or non-finite members with TypeError. Test empty, duplicates, order and invalid members." },
  { key: "06", predecessors: [], name: "normalizeKey", contract: () => "Export normalizeKey(value): trim and lowercase a string; throw TypeError for non-string input. Test padded mixed case, empty and invalid input." },
  { key: "07", predecessors: ["01"], name: "doubleIncrement", contract: (file) => `Import increment from ./${file("01")} and export doubleIncrement(n) = increment(increment(n)). Test 2 -> 4, 0 -> 2 and invalid input. Do not copy or edit the predecessor's source.` },
  { key: "08", predecessors: ["07"], name: "clampDoubleIncrement", contract: (file) => `Import doubleIncrement from ./${file("07")} and export clampDoubleIncrement(n, min, max): clamp the predecessor's result to inclusive finite numeric bounds; throw TypeError for invalid bounds or min > max. Test below, inside and above range.` },
  { key: "09", predecessors: ["08"], name: "isEvenClamped", contract: (file) => `Import clampDoubleIncrement from ./${file("08")} and export isEvenClamped(n, min, max): return true only when its integer result is even. Test an even and odd clamped result and invalid bounds.` },
  { key: "10", predecessors: ["09"], name: "describeParity", contract: (file) => `Import isEvenClamped from ./${file("09")} and export describeParity(n, min, max), returning "even" or "odd". Test both outputs and invalid bounds.` },
  { key: "11", predecessors: ["02"], name: "lowerCleanText", contract: (file) => `Import cleanText from ./${file("02")} and export lowerCleanText(value) returning the cleaned text in lowercase. Test mixed case and invalid input.` },
  { key: "12", predecessors: ["02"], name: "wordCount", contract: (file) => `Import cleanText from ./${file("02")} and export wordCount(value), counting words separated by whitespace after cleaning; empty text has zero words. Test empty, single and multiple spaces.` },
  { key: "13", predecessors: ["11", "12"], name: "textSummary", contract: (file) => `Import lowerCleanText from ./${file("11")} and wordCount from ./${file("12")}; export textSummary(value) returning {text, words}. Test both imports, empty and invalid input.` },
  { key: "14", predecessors: ["03", "04"], name: "parseNumberPair", contract: (file) => `Import safeInt and safeDecimal from the now-merged shared ./${file("03")} module. Export parseNumberPair(intText, decimalText) returning [integer, decimal] or null when either parse fails. Test both exports and invalid input.` },
  { key: "15", predecessors: ["14"], name: "sumNumberPair", contract: (file) => `Import parseNumberPair from ./${file("14")} and export sumNumberPair(a, b), returning the numeric sum or null on invalid input. Test positive, negative and invalid pairs.` },
  { key: "16", predecessors: ["14"], name: "multiplyNumberPair", contract: (file) => `Import parseNumberPair from ./${file("14")} and export multiplyNumberPair(a, b), returning the product or null on invalid input. Test zero, signed and invalid pairs.` },
  { key: "17", predecessors: ["05"], name: "countUnique", contract: (file) => `Import uniqueSorted from ./${file("05")} and export countUnique(values), returning the count of distinct numbers. Test empty, duplicates and invalid input.` },
  { key: "18", predecessors: ["05"], name: "firstUnique", contract: (file) => `Import uniqueSorted from ./${file("05")} and export firstUnique(values), returning its smallest number or null when empty. Test empty, duplicates and invalid input.` },
  { key: "19", predecessors: ["06"], name: "hyphenKey", contract: (file) => `Import normalizeKey from ./${file("06")} and export hyphenKey(value), replacing each nonempty run of whitespace with one hyphen. Test mixed case, multiple spaces and invalid input.` },
  { key: "20", predecessors: ["19"], name: "keyLength", contract: (file) => `Import hyphenKey from ./${file("19")} and export keyLength(value), returning the resulting string length. Test padded text, empty and invalid input.` },
];

const RUN_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function stressTasks(runKey: string): readonly StressTask[] {
  if (!RUN_KEY.test(runKey) || runKey.length > 64) throw new Error("Invalid stress run key");
  const filename = (key: string): string => `stress-${runKey}-${key === "03" || key === "04" ? "numbers" : key}.js`;
  return Object.freeze(DEFINITIONS.map(({ key, predecessors, name, contract }) => Object.freeze({
    key,
    predecessors: Object.freeze([...predecessors]),
    implementationFile: filename(key),
    testFile: `stress-${runKey}-${key}.test.js`,
    exportName: name,
    contract: contract(filename),
    runKey,
  })));
}

export function validateStressTasks(tasks: readonly StressTask[]): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (tasks.length !== DEFINITIONS.length) return { ok: false, reason: "wrong_task_count" };
  const seen = new Set<string>();
  const testFiles = new Set<string>();
  const implementations = new Map<string, string>();
  for (let i = 0; i < DEFINITIONS.length; i += 1) {
    const task = tasks[i]!;
    const expected = DEFINITIONS[i]!;
    if (task.key !== expected.key || task.predecessors.join(",") !== expected.predecessors.join(",")) return { ok: false, reason: `wrong_graph_at_${expected.key}` };
    if (!RUN_KEY.test(task.runKey) || task.testFile !== `stress-${task.runKey}-${task.key}.test.js` || !task.contract.trim()) return { ok: false, reason: `invalid_contract_${task.key}` };
    if (task.predecessors.some((key) => !seen.has(key))) return { ok: false, reason: `non_topological_${task.key}` };
    if (testFiles.has(task.testFile)) return { ok: false, reason: `duplicate_test_${task.key}` };
    testFiles.add(task.testFile);
    const first = implementations.get(task.implementationFile);
    if (first && !(first === "03" && task.key === "04")) return { ok: false, reason: `unexpected_shared_file_${task.key}` };
    implementations.set(task.implementationFile, first ?? task.key);
    seen.add(task.key);
  }
  if (tasks[2]?.implementationFile !== tasks[3]?.implementationFile) return { ok: false, reason: "missing_03_04_shared_file" };
  return { ok: true };
}

export function buildStressIssue(task: StressTask, projectId: string, predecessorIds: readonly string[]): Record<string, unknown> {
  if (!projectId.trim() || predecessorIds.length !== task.predecessors.length || predecessorIds.some((id) => !id.trim())) {
    throw new Error(`Invalid native blocker IDs for stress task ${task.key}`);
  }
  const targetFiles = [task.implementationFile, task.testFile];
  return {
    title: `Stress ${task.key}: ${task.exportName} [stress:${task.runKey}:${task.key}]`,
    description: `---\norchestrator_managed: true\ncomponent: "core"\ntarget_files: ${JSON.stringify(targetFiles)}\n---\n<!-- paperclip-adapters:stress-run:${task.runKey} -->\n\n${task.contract}\n\nImplement and export ${task.exportName} in CommonJS at ${task.implementationFile}. Add node:test coverage in ${task.testFile}; preserve existing exports and other tests. Run \`node --test ${task.testFile}\` and expect all tests to pass before opening a PR. Create exactly one PR for this task against master in the configured disposable repository.`,
    projectId,
    status: "backlog",
    priority: "medium",
    blockedByIssueIds: [...predecessorIds],
    assigneeAdapterOverrides: { adapterConfig: { ciPolicy: "skip" } },
  };
}
