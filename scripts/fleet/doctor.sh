#!/usr/bin/env bash
# ==============================================================================
# Paperclip Fleet Pre-Flight Diagnostic Doctor
#
# Validates system requirements, environment variables, API connectivity,
# GitHub CLI auth, and agent fleet health.
#
# Usage:
#   ./scripts/fleet/doctor.sh
# ==============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/common.sh"

echo "🩺 =============================================================================="
echo "🩺 Paperclip Fleet Pre-Flight Doctor"
echo "🩺 =============================================================================="
echo ""

FAILURES=0

pass() {
  echo "  ✅ $1"
}

fail() {
  echo "  ❌ $1" >&2
  echo "     👉 $2" >&2
  FAILURES=$((FAILURES + 1))
}

warn() {
  echo "  ⚠️  $1"
}

# 1. Check Node.js version
NODE_VERSION=$(node -v 2>/dev/null || echo "none")
if [ "${NODE_VERSION}" != "none" ]; then
  MAJOR=$(echo "${NODE_VERSION}" | sed 's/v//' | cut -d'.' -f1)
  if [ "${MAJOR}" -ge 22 ]; then
    pass "Node.js version: ${NODE_VERSION} (>= v22 required)"
  else
    fail "Node.js version: ${NODE_VERSION} is too old" "Install Node.js >= 22.0.0"
  fi
else
  fail "Node.js is not installed" "Install Node.js 22 from https://nodejs.org"
fi

# 2. Check pnpm
if command -v pnpm &>/dev/null; then
  PNPM_VER=$(pnpm -v)
  pass "pnpm version: ${PNPM_VER}"
else
  fail "pnpm is not installed" "Install pnpm with: npm install -g pnpm"
fi

# 3. Check CLI tools
if command -v curl &>/dev/null; then
  pass "curl is available"
else
  fail "curl is not installed" "Install curl via your package manager"
fi

if command -v jq &>/dev/null; then
  pass "jq is available"
else
  fail "jq is not installed" "Install jq via your package manager"
fi

# 4. Check GitHub CLI
if command -v gh &>/dev/null; then
  if gh auth status &>/dev/null; then
    pass "GitHub CLI (gh) is authenticated"
  else
    fail "GitHub CLI is installed but not authenticated" "Run: gh auth login"
  fi
else
  fail "GitHub CLI (gh) is not installed" "Install gh from https://cli.github.com"
fi

# 5. Check Paperclip Core Server Connectivity
echo ""
echo "🌐 Checking Paperclip Core Server at ${PAPERCLIP_API_URL}..."
if curl -s --connect-timeout 2 "${PAPERCLIP_API_URL}/api/companies/${COMPANY_ID}/agents" &>/dev/null; then
  pass "Paperclip server is reachable on ${PAPERCLIP_API_URL}"
  
  # 6. Check Managed Agents
  AGENTS_JSON=$(curl -s "${PAPERCLIP_API_URL}/api/companies/${COMPANY_ID}/agents")
  JULES_FOUND=$(echo "${AGENTS_JSON}" | jq -r --arg id "${JULES_WORKER_AGENT_ID}" '.[] | select(.id == $id) | .name' 2>/dev/null || echo "")
  REVIEWER_FOUND=$(echo "${AGENTS_JSON}" | jq -r --arg id "${REVIEWER_AGENT_ID}" '.[] | select(.id == $id) | .name' 2>/dev/null || echo "")
  ORCH_FOUND=$(echo "${AGENTS_JSON}" | jq -r --arg id "${ORCHESTRATOR_AGENT_ID}" '.[] | select(.id == $id) | .name' 2>/dev/null || echo "")
  
  if [ -n "${ORCH_FOUND}" ]; then
    pass "Task Orchestrator agent found (${ORCH_FOUND})"
  else
    fail "Task Orchestrator agent not found" "Run orchestrator provisioning"
  fi
  
  if [ -n "${JULES_FOUND}" ]; then
    pass "Jules Async Worker agent found (${JULES_FOUND})"
  else
    fail "Jules Async Worker not found" "Check company agents configuration"
  fi

  if [ -n "${REVIEWER_FOUND}" ]; then
    pass "Code Reviewer agent found (${REVIEWER_FOUND})"
  else
    warn "Code Reviewer agent not found (will be auto-provisioned)"
  fi
else
  fail "Cannot reach Paperclip server on ${PAPERCLIP_API_URL}" "Start server daemon with: npx -y paperclipai run"
fi

echo ""
echo "=============================================================================="
if [ "${FAILURES}" -eq 0 ]; then
  echo "🎉 Doctor Summary: All pre-flight checks passed! The fleet environment is ready."
  exit 0
else
  echo "⚠️ Doctor Summary: Found ${FAILURES} issue(s) that need attention." >&2
  exit 1
fi
