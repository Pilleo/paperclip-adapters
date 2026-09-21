import { parseMarkdownFrontmatter } from "./frontmatter.js";

export type TaskContract =
  | {
      readonly kind: "structured";
      readonly requirements: string;
      readonly targetFiles: readonly string[];
      readonly targetSymbols: readonly string[];
    }
  | {
      readonly kind: "unstructured";
      readonly requirements: string;
    };

function stringList(value: unknown): readonly string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
}

/**
 * Parses only canonical YAML frontmatter into executable scope hints. Inline
 * metadata-looking prose remains task text: guessing its structure previously
 * fabricated an empty plan that distracted Jules and restricted valid tests.
 */
export function parseTaskContract(rawDescription: string): TaskContract {
  const parsed = parseMarkdownFrontmatter<Record<string, unknown>>(rawDescription);
  const requirements = parsed.content.trim();
  const targetFiles = stringList(parsed.frontmatter["target_files"]);

  if (!parsed.hasFrontmatter || targetFiles.length === 0) {
    return { kind: "unstructured", requirements: rawDescription.trim() };
  }

  return {
    kind: "structured",
    requirements,
    targetFiles,
    targetSymbols: stringList(parsed.frontmatter["target_symbols"]),
  };
}
