export interface FileDiffBlock {
  readonly filePath: string;
  readonly header: string;
  readonly rawDiff: string;
  readonly additions: number;
  readonly deletions: number;
  readonly priorityScore: number;
}

export interface SmartDiffOptions {
  readonly maxCharBudget?: number | undefined; // default 12000 chars (~3000 tokens)
  readonly targetSymbols?: readonly string[] | undefined;
  readonly targetFiles?: readonly string[] | undefined;
  readonly highPriorityPatterns?: readonly string[] | undefined;
}

export interface SmartDiffResult {
  readonly formattedDiff: string;
  readonly manifest: string;
  readonly totalFiles: number;
  readonly includedFiles: readonly string[];
  readonly omittedFiles: readonly string[];
}

/**
 * Universal, project-agnostic priority scoring for file diffs based on architectural roles,
 * declared task targets, and code vs test vs config taxonomy.
 */
export function calculatePriorityScore(
  filePath: string,
  options: {
    targetFiles?: readonly string[] | undefined;
    targetSymbols?: readonly string[] | undefined;
    highPriorityPatterns?: readonly string[] | undefined;
  } = {}
): number {
  let score = 10;
  const lower = filePath.toLowerCase();

  // 1. Explicit Target Files: Maximum Priority (+100)
  if (options.targetFiles) {
    for (const tf of options.targetFiles) {
      if (tf && (lower === tf.toLowerCase() || lower.endsWith(tf.toLowerCase()))) {
        score += 100;
        break;
      }
    }
  }

  // 2. Declared Target Symbols (+80)
  if (options.targetSymbols) {
    for (const sym of options.targetSymbols) {
      if (sym && lower.includes(sym.toLowerCase())) {
        score += 80;
        break;
      }
    }
  }

  // 3. User/Project Configured High-Priority Patterns (+70)
  if (options.highPriorityPatterns) {
    for (const pat of options.highPriorityPatterns) {
      if (pat && lower.includes(pat.toLowerCase())) {
        score += 70;
        break;
      }
    }
  }

  // 4. Project-Agnostic Production Code Taxonomy (+50)
  const isProductionSource =
    lower.includes("src/main/") ||
    lower.includes("/src/") ||
    lower.startsWith("src/") ||
    lower.includes("/lib/") ||
    lower.startsWith("lib/") ||
    lower.includes("/pkg/") ||
    lower.startsWith("pkg/") ||
    lower.includes("/core/") ||
    lower.includes("/server/");

  const isTest =
    lower.includes("src/test/") ||
    lower.includes("/test/") ||
    lower.startsWith("test/") ||
    lower.includes("/tests/") ||
    lower.includes("/spec/") ||
    lower.includes("__tests__") ||
    lower.includes("test.") ||
    lower.includes("spec.");

  if (isProductionSource && !isTest) {
    score += 50;
  } else if (isTest) {
    score += 30;
  } else if (
    lower.endsWith(".gradle.kts") ||
    lower.endsWith(".gradle") ||
    lower.endsWith("pom.xml") ||
    lower.endsWith("package.json") ||
    lower.endsWith("cargo.toml") ||
    lower.endsWith("go.mod")
  ) {
    score += 15;
  } else if (lower.endsWith(".md") || lower.endsWith(".txt") || lower.includes("docs/")) {
    score += 5;
  }

  return score;
}

/**
 * Parses raw `git diff` output into discrete, structured per-file blocks.
 */
export function parseGitDiffIntoFiles(
  rawDiff: string,
  options: {
    targetFiles?: readonly string[] | undefined;
    targetSymbols?: readonly string[] | undefined;
    highPriorityPatterns?: readonly string[] | undefined;
  } = {}
): FileDiffBlock[] {
  if (!rawDiff || rawDiff.trim().length === 0) return [];

  const chunks = rawDiff.split(/(?=^diff --git )/m);
  const blocks: FileDiffBlock[] = [];

  for (const chunk of chunks) {
    if (!chunk.trim().startsWith("diff --git")) continue;

    const lines = chunk.split("\n");
    const diffHeader = lines[0] || "";
    // Match "diff --git a/path b/path"
    const match = diffHeader.match(/diff --git a\/(.+?) b\/(.+?)$/);
    const filePath = match && match[2] ? match[2] : "unknown";

    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }

    const priorityScore = calculatePriorityScore(filePath, options);

    blocks.push({
      filePath,
      header: diffHeader,
      rawDiff: chunk.trim(),
      additions,
      deletions,
      priorityScore,
    });
  }

  return blocks;
}

/**
 * Prioritizes file diff blocks project-agnostically and builds a token-efficient diff
 * with a comprehensive file manifest.
 */
export function prioritizeAndCompressDiff(
  blocks: readonly FileDiffBlock[],
  options: SmartDiffOptions = {}
): SmartDiffResult {
  const maxBudget = options.maxCharBudget || 12000;

  // Sort by priority descending (highest score first)
  const sorted = [...blocks].sort((a, b) => b.priorityScore - a.priorityScore);

  const included: FileDiffBlock[] = [];
  const omitted: FileDiffBlock[] = [];
  let currentLength = 0;

  for (const block of sorted) {
    if (currentLength + block.rawDiff.length <= maxBudget || included.length === 0) {
      included.push(block);
      currentLength += block.rawDiff.length;
    } else {
      omitted.push(block);
    }
  }

  // Construct Manifest Table
  const manifestLines: string[] = [
    "| Status | File Path | Changes |",
    "|---|---|---|",
  ];

  for (const inc of included) {
    manifestLines.push(`| ✅ FULL DIFF | \`${inc.filePath}\` | +${inc.additions}/-${inc.deletions} |`);
  }
  for (const omt of omitted) {
    manifestLines.push(`| 📋 OUTLINE | \`${omt.filePath}\` | +${omt.additions}/-${omt.deletions} (use \`git diff\` if needed) |`);
  }

  const manifest = manifestLines.join("\n");
  const formattedDiff = included.map((b) => b.rawDiff).join("\n\n");

  return {
    formattedDiff,
    manifest,
    totalFiles: blocks.length,
    includedFiles: included.map((b) => b.filePath),
    omittedFiles: omitted.map((b) => b.filePath),
  };
}
