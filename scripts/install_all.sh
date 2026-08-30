#!/usr/bin/env bash
# ==============================================================================
# Paperclip All-in-One Installer Script
#
# Builds and installs all Paperclip adapters (Orchestrator, Jules, Vibe, Antigravity)
# and the Telegram companion plugin into your local Paperclip instance (~/.paperclip).
#
# Usage:
#   ./scripts/install_all.sh
#   pnpm fleet:install
# ==============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${DIR}/.." && pwd)"

echo "📦 =============================================================================="
echo "📦 Paperclip Adapters & Telegram Plugin All-in-One Installer"
echo "📦 =============================================================================="
echo ""

# 1. Build all packages
echo "🔨 1. Building all monorepo TypeScript packages..."
cd "${ROOT_DIR}"
pnpm build
echo "   ✅ Build successful."
echo ""

# 2. Setup ~/.paperclip directories
PAPERCLIP_DIR="${HOME}/.paperclip"
ADAPTER_PLUGINS_DIR="${PAPERCLIP_DIR}/adapter-plugins"
PLUGINS_DIR="${PAPERCLIP_DIR}/plugins"

mkdir -p "${PAPERCLIP_DIR}"
mkdir -p "${ADAPTER_PLUGINS_DIR}"
mkdir -p "${PLUGINS_DIR}"

# 3. Register All Adapters in adapter-plugins.json
echo "🔌 2. Registering adapters in Paperclip (adapter-plugins.json)..."
node -e '
const fs = require("fs");
const path = require("path");

const root = process.argv[1];
const paperclipDir = process.argv[2];
const configFile = path.join(paperclipDir, "adapter-plugins.json");

const adapters = [
  { type: "orchestrator", pkgDir: path.join(root, "packages/orchestrator") },
  { type: "vibe", pkgDir: path.join(root, "packages/vibe") },
  { type: "jules", pkgDir: path.join(root, "packages/jules") },
  { type: "antigravity", pkgDir: path.join(root, "packages/antigravity") },
];

let current = [];
if (fs.existsSync(configFile)) {
  try {
    current = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch {}
}

for (const ad of adapters) {
  const pkgJsonPath = path.join(ad.pkgDir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) continue;
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  
  const existingIdx = current.findIndex(c => c.type === ad.type || c.localPath === ad.pkgDir);
  const entry = {
    packageName: pkg.name || ad.pkgDir,
    localPath: ad.pkgDir,
    version: pkg.version || "0.1.0",
    type: ad.type,
    installedAt: new Date().toISOString()
  };
  
  if (existingIdx >= 0) {
    current[existingIdx] = entry;
  } else {
    current.push(entry);
  }
}

fs.writeFileSync(configFile, JSON.stringify(current, null, 2) + "\n", "utf8");
console.log("   ✅ Registered adapters:", adapters.map(a => a.type).join(", "));
' "${ROOT_DIR}" "${PAPERCLIP_DIR}"
echo ""

# 4. Install & Link Telegram Plugin in ~/.paperclip/plugins
echo "📱 3. Installing & Linking Telegram Plugin in ~/.paperclip/plugins..."
cd "${PLUGINS_DIR}"
if [ ! -f "package.json" ]; then
  echo '{"name":"paperclip-plugins","private":true}' > package.json
fi

TELEGRAM_DIR="${ROOT_DIR}/packages/telegram"
npm install --no-save "${TELEGRAM_DIR}"
echo "   ✅ Telegram plugin installed into ~/.paperclip/plugins"
echo ""

# 5. Summary & Verification
echo "🩺 4. Running Pre-Flight Doctor..."
cd "${ROOT_DIR}"
./scripts/fleet/doctor.sh

echo ""
echo "🎉 =============================================================================="
echo "🎉 Installation Complete!"
echo "🎉 All 4 Adapters (Orchestrator, Jules, Vibe, Antigravity) + Telegram Plugin are ready."
echo "🎉 =============================================================================="
