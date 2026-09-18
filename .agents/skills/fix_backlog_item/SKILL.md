---
name: fix_backlog_item
description: >
  TDD protocol for an open ADK backlog item. Trigger on: fix backlog, implement
  this issue, resolve issue.
---

# Fix backlog item

1. Check git status before any code changes. If unrelated entries are present, do not modify, stage, or resolve around them; ask the owner whether to work in place, isolate, or defer.
2. Read the issue in `docs/internals/backlog/`. Answer its questions from the repo before asking a human.
3. `./scripts/adkw doctor` and `./scripts/adkw blast-radius <Symbol>`. If Codanna is not `READY`, record degraded evidence and continue.
4. Write a failing test. Do not implement until it fails for the right reason.
5. Implement the smallest fix. Do not swallow errors, disable tests, or weaken guards to get green.
6. `./scripts/adkw guard <changed-file> --stage syntax` then the project test command.
7. `./scripts/adkw check-backlog`. Do not resolve the issue if `./scripts/adkw check-delivery` reports a dirty worktree with unrelated files.
8. Set `status: resolved` and move the file to `docs/internals/backlog/resolved/`.
