---
name: ast_grep
description: >
  Syntax-aware search with ast-grep. Use for structural find/replace, not text grep.
---

# ast-grep

Prefer `ast-grep` on PATH. If it is missing, say so and use `./scripts/adkw slice` / `symbol-source` instead.

```bash
ast-grep run --lang kotlin --pattern 'fun $NAME($$$)' src/
ast-grep run --lang kotlin --kind function_declaration --json=compact --stdin < file.kt
```

Always pass `--lang` and a path. Confirm replacements with tests. Do not treat search hits as verified ranges; verify with ADK `symbol-source`.

## Candidate search with direct zg

When exact anchors are unknown, read `zg --help` and `zg query --help` first. From the repository root:

```bash
zg query --mode direct --limit 5 --preview short "<query>"
```

This replaces the removed discover wrapper for candidate ranking only. Verify candidates with ast-grep, `./scripts/adkw symbol-source`, or Codanna before source reads or edits. Stale hits, missing tools/indexes, failed queries, and empty output are incomplete evidence, not proof of absence.

Direct zg does not supply ADK schema-v1 envelopes, exit-code mapping, the 15-second timeout, 12,000-character truncation, or Git provenance. Bound execution and captured output in the calling tool; record command, working directory, revision, exit status, stderr, and any timeout or truncation.

Keep `guard` / hooks, `slice` / `symbol-source`, and `blast-radius` for verification and evidence.
