# Work packages

Lint with:

```bash
node packages/common/bin/lint-backlog.js docs/internals/backlog
```

Each `issue-YYYYMMDD-HHMMSS-slug.md` must have YAML frontmatter (`title`, `component`, `target_modules`, `target_files`), plus **Context:** and **Needed:**. `target_modules` may be mazewall Gradle ids or this repo's npm workspaces (`packages/jules`, …).
