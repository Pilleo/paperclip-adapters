---
name: file_structure
description: >
  Outline a source file before reading it. Use before inspecting Kotlin/Java/TS
  or asking what a class contains. Trigger on: file structure, outline, what is
  in this file, methods in X.
---

# File structure

Do not read a whole source file first.

1. `./scripts/adkw slice <file-or-class> --json`
2. If the envelope warns `STRUCTURE_FIRST`, follow its drill-down instructions (ast-grep for methods, `symbol-source` for one symbol or data key). Use `slice --full` only when structure is insufficient. Do not ask for the rest.
3. If the envelope is `PARTIAL` or `UNAVAILABLE`, say so. Do not treat lexical fallback as parser-verified.
4. For one symbol or data key: `./scripts/adkw symbol-source <file> <symbol> --json`
5. If Codanna is missing, continue with ADK evidence and record that impact data is incomplete.
6. `adk metrics` shows cumulative input/output/saved bytes proving the compaction; ledger writes never fail a command.

Optional: `codanna retrieve describe <Symbol>` after `./scripts/adkw doctor` reports `READY`.
