import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT_DIR, "dist-packages");

const PACKAGES = [
  { name: "@pilleo/paperclip-adapter-common", dir: "packages/common" },
  { name: "@pilleo/paperclip-orchestrator-adapter", dir: "packages/orchestrator" },
  { name: "@pilleo/paperclip-jules-adapter", dir: "packages/jules" },
  { name: "@pilleo/paperclip-vibe-adapter", dir: "packages/vibe" },
  { name: "@pilleo/paperclip-antigravity-adapter", dir: "packages/antigravity" },
  { name: "@pilleo/paperclip-telegram-plugin", dir: "packages/telegram" },
];

console.log("================================================================================");
console.log("  📦 PAPERCLIP ADAPTERS RELEASE & PACKAGING PIPELINE");
console.log("================================================================================");

// 1. Build and Test full monorepo
console.log("\n[1/4] 🔨 Compiling TypeScript & running full test matrix...");
execSync("pnpm -r build && pnpm -r test", { cwd: ROOT_DIR, stdio: "inherit" });
console.log("✅ All monorepo builds and tests passed!");

// 2. Prepare release directory
if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DIST_DIR, { recursive: true });

// 3. Validate package.json manifests
console.log("\n[2/4] 🔍 Validating package manifests and Paperclip entrypoints...");
for (const pkg of PACKAGES) {
  const pkgJsonPath = path.join(ROOT_DIR, pkg.dir, "package.json");
  const raw = fs.readFileSync(pkgJsonPath, "utf-8");
  const json = JSON.parse(raw);

  if (!json.name || !json.version) {
    throw new Error(`Package ${pkg.dir} is missing name or version!`);
  }
  if (!json.main || !fs.existsSync(path.join(ROOT_DIR, pkg.dir, json.main))) {
    throw new Error(`Package ${pkg.name} main entrypoint "${json.main}" does not exist on disk!`);
  }
  if (json.types && !fs.existsSync(path.join(ROOT_DIR, pkg.dir, json.types))) {
    throw new Error(`Package ${pkg.name} types entrypoint "${json.types}" does not exist on disk!`);
  }
  console.log(`✓ ${pkg.name}@${json.version} manifest & entrypoints valid.`);
}

// 4. Pack each package into tarballs
console.log("\n[3/4] 📦 Creating production tarballs via npm pack...");
const packedTarballs: { name: string; file: string; sizeKb: number }[] = [];

for (const pkg of PACKAGES) {
  const pkgDir = path.join(ROOT_DIR, pkg.dir);
  const out = execSync("npm pack --pack-destination " + JSON.stringify(DIST_DIR), {
    cwd: pkgDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  const tarballName = out.split("\n").pop()?.trim() || "";
  const tarballPath = path.join(DIST_DIR, tarballName);

  if (!fs.existsSync(tarballPath)) {
    throw new Error(`Failed to locate generated tarball for ${pkg.name} at ${tarballPath}`);
  }

  const stat = fs.statSync(tarballPath);
  packedTarballs.push({
    name: pkg.name,
    file: tarballName,
    sizeKb: Math.round((stat.size / 1024) * 10) / 10,
  });
}

// 5. Summary
console.log("\n[4/4] 🎉 Release Packaging Complete!");
console.log("\n================================================================================");
console.log("  📦 RELEASED PACKAGES (Ready for Paperclip deployment / npm publish):");
console.log("================================================================================");
for (const item of packedTarballs) {
  console.log(`• ${item.name.padEnd(42)} -> dist-packages/${item.file} (${item.sizeKb} KB)`);
}
console.log("================================================================================\n");
