# @pilleo/paperclip-orchestrator-adapter

Production-grade, deterministic multi-lane orchestrator adapter for Paperclip.

## Features
- **Deterministic Multi-Lane Scheduling:** Governs Jules cloud async runs (max 15), Vibe local runs (max 2), and Antigravity local runs.
- **Method-Level DAG Matrix:** Calculates AST symbol conflicts and allows fine-grained method parallel execution while locking overlapping symbols.
- **Self-Healing Stalled Session Reaper:** Detects and auto-reclaims abandoned in-progress tasks back to `todo`.
- **Pluggable Invariant Engine:** Validates project-specific security and code hygiene rules declaratively via `.paperclip/invariants.json`.
- **Autonomous Clarifier Loop:** Researches open questions via Codanna before escalating to human operator approval cards.
- **Live Board Approval Gating:** Traps unapproved tasks in `todo` until board approval is granted.

## Configuration Schema
```json
{
  "maxConcurrentJules": 15,
  "maxConcurrentVibe": 2,
  "requireTaskApproval": true,
  "stalledThresholdMinutes": 15,
  "workspacePath": "/path/to/project",
  "backlogDirectory": "docs/internals/backlog",
  "resolvedDirectory": "docs/internals/backlog/resolved"
}
```
