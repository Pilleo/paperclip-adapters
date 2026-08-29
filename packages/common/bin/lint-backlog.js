#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { validateBacklogDirectory } from "../dist/index.js";

const args = process.argv.slice(2);
let targetDir = args[0] || "docs/internals/backlog";
if (targetDir === "lint") {
  targetDir = args[1] || "docs/internals/backlog";
}

const resolvedDir = path.resolve(process.cwd(), targetDir);

console.log(`\x1b[36m🔍 Inspecting backlog integrity at:\x1b[0m ${resolvedDir}`);

const t0 = performance.now();
const res = validateBacklogDirectory(resolvedDir);
const elapsed = (performance.now() - t0).toFixed(2);

console.log(`\x1b[34m📊 Scanned ${res.totalIssues} backlog files in ${elapsed}ms\x1b[0m\n`);

if (res.errors.length === 0) {
  console.log(`\x1b[32m✅ All ${res.validCount}/${res.totalIssues} backlog issue files are strictly valid!\x1b[0m`);
  process.exit(0);
} else {
  console.error(`\x1b[31m❌ Found ${res.errors.length} validation errors across ${res.totalIssues - res.validCount} files:\x1b[0m\n`);
  for (const err of res.errors) {
    console.error(`  \x1b[33m• ${err.file}\x1b[0m: ${err.message}`);
  }
  process.exit(1);
}
