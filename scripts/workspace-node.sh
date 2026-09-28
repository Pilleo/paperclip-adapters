#!/usr/bin/env bash
# Run a command with the repository's Mise-managed Node before system PATH.
# systemd user units otherwise select /usr/bin/node (currently v22), which
# cannot safely execute this workspace's Node-24 pnpm installation.
set -euo pipefail

if [[ -n "${MISE_NODE_BIN:-}" && -x "${MISE_NODE_BIN}/node" ]]; then
  node_bin="${MISE_NODE_BIN}"
elif [[ -x "${HOME}/.local/share/mise/installs/node/lts/bin/node" ]]; then
  node_bin="${HOME}/.local/share/mise/installs/node/lts/bin"
else
  echo "workspace-node: no Mise-managed Node runtime found" >&2
  exit 127
fi

export PATH="${node_bin}:${PATH}"
exec "$@"
