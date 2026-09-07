#!/usr/bin/env bash
# Installs the board-owned local convergence timer. This does not grant an
# adapter any board credential; the service uses the existing Paperclip CLI
# board context owned by the current user.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT_DIR="${HOME}/.config/systemd/user"
mkdir -p "${UNIT_DIR}"
install -m 0644 "${ROOT_DIR}/scripts/fleet/systemd/paperclip-jules-pr-reconciler.service" "${UNIT_DIR}/paperclip-jules-pr-reconciler.service"
install -m 0644 "${ROOT_DIR}/scripts/fleet/systemd/paperclip-jules-pr-reconciler.timer" "${UNIT_DIR}/paperclip-jules-pr-reconciler.timer"
systemctl --user daemon-reload
systemctl --user enable --now paperclip-jules-pr-reconciler.timer
systemctl --user start paperclip-jules-pr-reconciler.service
systemctl --user status paperclip-jules-pr-reconciler.timer --no-pager
