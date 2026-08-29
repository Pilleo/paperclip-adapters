import YAML from "yaml";

export interface ParsedMarkdown<T = Record<string, unknown>> {
  frontmatter: T;
  content: string;
  hasFrontmatter: boolean;
}

export function parseMarkdownFrontmatter<T = Record<string, unknown>>(rawMarkdown: string): ParsedMarkdown<T> {
  const match = rawMarkdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return {
      frontmatter: {} as T,
      content: rawMarkdown.trim(),
      hasFrontmatter: false,
    };
  }

  const yamlBlock = match[1] ?? "";
  const content = (match[2] ?? "").trim();

  try {
    const parsed = (YAML.parse(yamlBlock) as T) || ({} as T);
    return {
      frontmatter: parsed,
      content,
      hasFrontmatter: true,
    };
  } catch {
    return {
      frontmatter: {} as T,
      content: rawMarkdown.trim(),
      hasFrontmatter: false,
    };
  }
}

export function serializeMarkdownFrontmatter<T extends Record<string, unknown>>(frontmatter: T, content: string): string {
  const yaml = YAML.stringify(frontmatter).trim();
  return `---\n${yaml}\n---\n\n${content.trim()}\n`;
}
