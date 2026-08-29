import { describe, it, expect, vi, beforeEach } from "vitest";
import { materializeWorkspaceSkillsAndRules } from "../src/index.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("skills-materializer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-mat-test-"));
  });

  it("materializes root AGENTS.md and discovered skills", () => {
    // 1. Create AGENTS.md
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "# Mazewall Rules\nNever break JVM seccomp rules.");

    // 2. Create .agents/skills/add_syscall/SKILL.md
    const skillDir = path.join(tmpDir, ".agents", "skills", "add_syscall");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---
name: add_syscall
description: Checklist for adding a Linux syscall
---
# Instructions
Check Syscall.kt first.`
    );

    const res = materializeWorkspaceSkillsAndRules(tmpDir);
    expect(res.rulesFound).toContain("AGENTS.md");
    expect(res.skillsFound).toContain("add_syscall");
    expect(res.bundleContent).toContain("Never break JVM seccomp rules");
    expect(res.bundleContent).toContain("Skill: add_syscall");
  });

  it("returns empty bundle gracefully for empty workspace", () => {
    const res = materializeWorkspaceSkillsAndRules(tmpDir);
    expect(res.rulesFound).toHaveLength(0);
    expect(res.skillsFound).toHaveLength(0);
    expect(res.bundleContent).toBe("");
  });
});
