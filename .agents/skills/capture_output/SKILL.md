---
name: capture_output
description: >
  Run a command whose output may be large. Use before running builds,
  test suites, searches, or any command that can flood context.
  Trigger on: big output, capture output, run and save, long logs.
---

# Capture-then-search command output

Never let a big command dump into context. Capture it, read the bounded
report, then search the saved logs.

1. `./scripts/adk-run-captured [--limit BYTES] [--timeout SECONDS] [--log-dir DIR] -- COMMAND [ARG ...]`
2. Read the JSON report: `status` (`ok` / `failed` / `timeout` / `interrupted` / `launch_error` / `capture_error`), `exit_code`, per-stream `bytes`, `truncated`, `preview`, and log `file` paths.
3. Search the saved logs instead of re-running: `rg -n <pattern> <log file>` (exact) or `zg query` (semantic). Quote the first match with its line number; pull surrounding lines only as needed.
4. Full logs are never shortened; only the report preview is bounded (8 KiB total by default). A `status.json` sits next to the logs for the audit trail.
5. Requires Python 3 (standard library only). Always pass `--` before the command. Give long commands an explicit `--timeout`.
