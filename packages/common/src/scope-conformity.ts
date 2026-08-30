export interface ScopeConformityParams {
  readonly declaredTargetFiles?: readonly string[] | undefined;
  readonly declaredTargetSymbols?: readonly string[] | undefined;
  readonly modifiedFiles: readonly string[];
  readonly rawDiff?: string | undefined;
}

export interface ScopeConformityReport {
  readonly isConformant: boolean;
  readonly conformityScore: number;
  readonly matchedFiles: readonly string[];
  readonly unplannedFiles: readonly string[];
  readonly missingTargetFiles: readonly string[];
  readonly symbolMatches: readonly { readonly symbol: string; readonly foundInDiff: boolean }[];
  readonly summaryText: string;
}

function normalizePath(p: string): string {
  return p.trim().replace(/^\.?\//, "").toLowerCase();
}

export function evaluateScopeConformity(params: ScopeConformityParams): ScopeConformityReport {
  const declaredFiles = (params.declaredTargetFiles || []).map(normalizePath);
  const declaredSymbols = params.declaredTargetSymbols || [];
  const modifiedFiles = params.modifiedFiles.map(normalizePath);
  const rawDiff = params.rawDiff || "";

  if (declaredFiles.length === 0 && declaredSymbols.length === 0) {
    return {
      isConformant: true,
      conformityScore: 100,
      matchedFiles: params.modifiedFiles,
      unplannedFiles: [],
      missingTargetFiles: [],
      symbolMatches: [],
      summaryText: "ℹ️ No declared target constraints; all modified files accepted as open scope.",
    };
  }

  const matchedFiles: string[] = [];
  const unplannedFiles: string[] = [];
  const missingTargetFiles: string[] = [];

  for (const mod of params.modifiedFiles) {
    const norm = normalizePath(mod);
    const isTarget = declaredFiles.some((df) => norm === df || norm.endsWith(df) || df.endsWith(norm));
    if (isTarget) {
      matchedFiles.push(mod);
    } else {
      unplannedFiles.push(mod);
    }
  }

  for (const dec of params.declaredTargetFiles || []) {
    const norm = normalizePath(dec);
    const wasModified = modifiedFiles.some((mf) => mf === norm || mf.endsWith(norm) || norm.endsWith(mf));
    if (!wasModified) {
      missingTargetFiles.push(dec);
    }
  }

  const symbolMatches: { symbol: string; foundInDiff: boolean }[] = [];
  for (const sym of declaredSymbols) {
    if (!sym) continue;
    const cleanSym = sym.split(/[.#]/).pop() || sym;
    const found = rawDiff.includes(sym) || rawDiff.includes(cleanSym);
    symbolMatches.push({ symbol: sym, foundInDiff: found });
  }

  const missingSymbols = rawDiff.trim().length > 0
    ? symbolMatches.filter((s) => !s.foundInDiff).map((s) => s.symbol)
    : [];

  let score = 100;
  if (unplannedFiles.length > 0) score -= unplannedFiles.length * 15;
  if (missingTargetFiles.length > 0) score -= missingTargetFiles.length * 25;
  if (missingSymbols.length > 0) score -= missingSymbols.length * 10;
  score = Math.max(0, Math.min(100, score));

  const isConformant =
    unplannedFiles.length === 0 && missingTargetFiles.length === 0 && missingSymbols.length === 0;
  const summaryLines: string[] = [];
  if (isConformant) {
    summaryLines.push("✅ **Scope & Plan Conformity:** Diff confined to declared target files and symbols.");
  } else {
    summaryLines.push("⚠️ **Scope Drift Detected:**");
    if (unplannedFiles.length > 0) {
      summaryLines.push(`- **Unplanned Modified Files (${unplannedFiles.length}):** ${unplannedFiles.map((f) => `\`${f}\``).join(", ")}`);
    }
    if (missingTargetFiles.length > 0) {
      summaryLines.push(`- **Missing Declared Target Files (${missingTargetFiles.length}):** ${missingTargetFiles.map((f) => `\`${f}\``).join(", ")}`);
    }
    if (missingSymbols.length > 0) {
      summaryLines.push(`- **Declared symbols missing from the diff (${missingSymbols.length}):** ${missingSymbols.map((s) => `\`${s}\``).join(", ")}`);
    }
  }

  return {
    isConformant,
    conformityScore: score,
    matchedFiles: Object.freeze(matchedFiles),
    unplannedFiles: Object.freeze(unplannedFiles),
    missingTargetFiles: Object.freeze(missingTargetFiles),
    symbolMatches: Object.freeze(symbolMatches),
    summaryText: summaryLines.join("\n"),
  };
}
