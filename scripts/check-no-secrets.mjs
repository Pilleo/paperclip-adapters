#!/usr/bin/env node
/**
 * Lightweight defence-in-depth check for credentials accidentally added to
 * this adapter repository. It deliberately reports only file and line number,
 * never the matched value. Use --all in CI; the default checks staged changes.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const allFiles = process.argv.includes("--all");
const files = execFileSync("git", allFiles ? ["ls-files"] : ["diff", "--cached", "--name-only"], {
  encoding: "utf8",
}).split("\n").filter(Boolean);
const patterns = [
  { name: "Jules API key", expression: /\bJULES_API_KEY\s*[=:]\s*(?!\{|\$\{|\$[A-Z_]+\b|<[^>]+>|your[_ -]?token\b)[^\s"']+/i },
  { name: "Paperclip token", expression: /\bPAPERCLIP_(?:AGENT_TOKEN|API_KEY)\s*[=:]\s*(?!\{|\$\{|\$[A-Z_]+\b|<[^>]+>|your[_ -]?token\b)[^\s"']+/i },
  { name: "OpenAI-style secret", expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/ },
  { name: "GitHub token", expression: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
];
const findings = [];
for (const file of files) {
  if (file === ".env.example" || /(^|\/)(?:test|tests|fixtures)(\/|$)/.test(file)) continue;
  let lines;
  try { lines = readFileSync(file, "utf8").split("\n"); } catch { continue; }
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      if (pattern.expression.test(line)) findings.push(`${file}:${index + 1} (${pattern.name})`);
    }
  });
}
if (findings.length) {
  console.error("Potential secret detected; remove it and use a local ignored environment file instead:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log(`Secret check passed (${allFiles ? "tracked files" : "staged changes"}).`);
