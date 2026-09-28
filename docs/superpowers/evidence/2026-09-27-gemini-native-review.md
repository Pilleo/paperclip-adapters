# Gemini 3.8 typed review on unpatched Paperclip

One opt-in isolated contract run used installed Paperclip `2026.916.0`, a real disposable PostgreSQL database, host-minted run credentials, and the actual Gemini 3.8 Flash Low provider through the Antigravity ACP adapter.

## Failure and correction

- The first run used the interactive `agy` CLI as `agentCommand` and failed with `acpx_handshake_timeout`; no verdict was submitted. The CLI is not the ACP server.
- The installed executable `agy_acp_server.par` accepted ACP `initialize` with its required `--uid=` flag. The adapter now refuses the interactive CLI for `nativeReview: true`, and managed-fleet reconciliation discovers/configures the executable ACP server (or uses `ANTIGRAVITY_ACP_SERVER` when explicitly set).

## Positive proof

Report: `/tmp/paperclip-gemini-native-acp-proof/stable_child_gemini.json`.

```sh
PAPERCLIP_GEMINI_ACP_SERVER=/absolute/path/to/agy_acp_server.par \
CONTRACT_REPORT_DIR=/tmp/paperclip-gemini-native-proof \
pnpm test:contract:gemini-plan-review
```

The real Gemini run submitted a typed `approve` on card `5ba4b174-e7ab-4515-a879-fc8b0f806c04`. Paperclip attributed it to reviewer run `dd45de95-9fa4-4fd9-9d1a-2fd4c2f5bb8d`, distinct from bootstrap source run `a37abb9d-7f33-404e-aed0-20dbb5f2ab27`. The card targeted the parent plan document's exact revision; the parent stayed Jules-owned and in progress. Model execution returned exit code 0; contract safety gate passed. No Codex home or Codex model was used for this reviewer.

This proves Gemini's *typed plan verdict transport*. The complete live Jules plan-approval, PR, merge, and dependent A→B→C progression remain separate qualifications. In particular, the provider session's unexpected `COMPLETED` transition is not resolved by this reviewer proof.
