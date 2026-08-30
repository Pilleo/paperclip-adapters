#!/usr/bin/env bash
# ==============================================================================
# Run Paperclip Telegram Companion Bot
#
# Connects Paperclip with Telegram to provide:
# - Live board summaries & task approval cards.
# - Push notifications on agent health incidents & code review outcomes.
#
# Usage:
#   ./scripts/fleet/run_telegram_companion.sh
# ==============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${DIR}/../.." && pwd)"

echo "🤖 Starting Paperclip Telegram Companion from ${ROOT}..."
node "${ROOT}/packages/telegram/bin/paperclip-telegram.js"
