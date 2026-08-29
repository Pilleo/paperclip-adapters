import fs from "node:fs";
import path from "node:path";
import { parseMarkdownFrontmatter } from "./frontmatter.js";

export interface MaterializedSkillsResult {
  readonly bundleContent: string;
  readonly skillsFound: readonly string[];
  readonly rulesFound: readonly string[];
}

export function materializeWorkspaceSkillsAndRules(workspacePath: string): MaterializedSkillsResult {
  const skillsFound: string[] = [];
  const rulesFound: string[] = [];
  const sections: string[] = [];

  // 1. Root AGENTS.md / GEMINI.md
  const agentFiles = ["AGENTS.md", "GEMINI.md", ".agents/CODE_QUALITY.md"];
  for (const rel of agentFiles) {
    const full = path.join(workspacePath, rel);
    if (fs.existsSync(full)) {
      try {
        const content = fs.readFileSync(full, "utf8").trim();
        if (content) {
          rulesFound.push(rel);
          sections.push(`## 📜 Rule: ${rel}\n\n${content}\n`);
        }
      } catch {}
    }
  }

  // 2. Scan .agents/skills/ and skills/
  const skillRoots = [path.join(workspacePath, ".agents", "skills"), path.join(workspacePath, "skills")];
  for (const sRoot of skillRoots) {
    if (fs.existsSync(sRoot) && fs.statSync(sRoot).isDirectory()) {
      try {
        const entries = fs.readdirSync(sRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillMd = path.join(sRoot, entry.name, "SKILL.md");
            if (fs.existsSync(skillMd)) {
              const raw = fs.readFileSync(skillMd, "utf8");
              const { frontmatter, content } = parseMarkdownFrontmatter<Record<string, unknown>>(raw);
              const skillName = typeof frontmatter["name"] === "string" ? frontmatter["name"] : entry.name;
              const skillDesc = typeof frontmatter["description"] === "string" ? frontmatter["description"] : "";

              skillsFound.push(skillName);
              sections.push(`### 🛠️ Skill: ${skillName}\n**Description:** ${skillDesc}\n\n${content.slice(0, 4000)}\n`);
            }
          }
        }
      } catch {}
    }
  }

  const header = `# 🏛️ Workspace Knowledge & Skills Bundle\nGenerated automatically for local execution agent.\n\n`;
  const bundleContent = sections.length > 0 ? header + sections.join("\n---\n\n") : "";

  return {
    bundleContent,
    skillsFound: Object.freeze(skillsFound),
    rulesFound: Object.freeze(rulesFound),
  };
}
