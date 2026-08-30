# 📎 Paperclip Adapters & Multi-Agent Orchestration Monorepo

Production-grade, deterministic, multi-agent fleet adapters and orchestration control plane for **[Paperclip AI](https://github.com/paperclipai/paperclip)**.

---

## 🧭 Developer Navigation & Documentation

- 🚀 **[Developer Onboarding Guide (ONBOARDING.md)](docs/ONBOARDING.md)**: Zero-to-hero setup, architecture mental model, and daily workflows.
- 🛡️ **[Contributing Guidelines & Invariants (CONTRIBUTING.md)](CONTRIBUTING.md)**: Engineering rules, anti-hack standards, review protocols, and TDD practices.
- 🛠️ **[Fleet Operations Runbook (scripts/fleet/README.md)](scripts/fleet/README.md)**: Ready-to-run operational scripts and curl helpers.

---

## 🏛️ System Architecture

```
                                    ┌─────────────────────────────────────┐
                                    │      Paperclip Core Server          │
                                    │    (Postgres + HTTP API :3100)      │
                                    └──────────────────┬──────────────────┘
                                                       │
                           ┌───────────────────────────┴───────────────────────────┐
                           ▼                                                       ▼
        ┌──────────────────────────────────────┐                ┌──────────────────────────────────────┐
        │  Task Orchestrator                   │                │  Telegram Operator Companion         │
        │  (@pilleo/paperclip-orchestrator)    │                │  (@pilleo/paperclip-telegram)        │
        │  • Fine-Grained AST Lock Matrix      │                │  • 1-Click Task Start Approvals      │
        │  • Multi-Tier PR Review Ladder       │                │  • Stage 4 Merge Approval Cards      │
        │  • Agent Failure & Health Monitor    │                │  • Real-time Incident Alerts         │
        └──────────────────┬───────────────────┘                └──────────────────────────────────────┘
                           │
        ┌──────────────────┴───────────────────────────────────────────────────────┐
        ▼                                      ▼                                   ▼
┌───────────────────────────────┐  ┌───────────────────────────────┐  ┌───────────────────────────────┐
│ [Orchestrated] Jules Worker   │  │ [Orchestrated] Vibe Worker    │  │ [Orchestrated] Code Reviewer  │
│ (Cloud Async Developer)       │  │ (Local Fast ACP Developer)    │  │ (Terra/Grok Strong Reviewer)  │
│ • Long-running cloud sessions │  │ • Fast AST refactoring        │  │ • Kernel & FFM Invariant audit│
│ • Surgical git branch commits │  │ • Q&A clarification interviews│  │ • Strict zero-bypass checks   │
│ • Direct session review relay │  │ • Stage 2 fast PR triage      │  │ • Token-efficient diff review │
└───────────────────────────────┘  └───────────────────────────────┘  └───────────────────────────────┘
```

---

## ⚡ Quick Operational Commands (`pnpm fleet:*`)

```bash
pnpm fleet:doctor     # 🩺 Run pre-flight environment & API connectivity doctor
pnpm fleet:dashboard  # 🎛️ Launch single-pane terminal status dashboard
pnpm fleet:tick       # 🚀 Trigger immediate deterministic scheduling tick
pnpm fleet:agents     # 🤖 List all fleet agents & live health status
pnpm fleet:issues     # 📋 View company board tasks and assignees
pnpm fleet:approvals  # 🏛️ View pending start gates & Stage 4 merge approval cards
pnpm fleet:telegram   # 📱 Start interactive Telegram companion bot
```

---

## 📦 Monorepo Packages

| Package | Version | Description |
|---|---|---|
| [`@pilleo/paperclip-orchestrator-adapter`](packages/orchestrator) | `0.1.0` | Fleet scheduler for **[Orchestrated]** workers only. Independent Jules/Vibe/AGY agents stay for other workflows. |
| [`@pilleo/paperclip-jules-adapter`](packages/jules) | `0.1.0` | Google Jules cloud async execution bridge with pure lifecycle state machine. |
| [`@pilleo/paperclip-vibe-adapter`](packages/vibe) | `0.1.0` | Mistral Vibe ACP adapter for local rapid clarifications and Stage 2 code review. |
| [`@pilleo/paperclip-antigravity-adapter`](packages/antigravity) | `0.1.0` | Google Antigravity ACP adapter for deep systems pair programming. |
| [`@pilleo/paperclip-telegram-plugin`](packages/telegram) | `0.1.0` | Push notifications and interactive approval bot for Telegram. |
| [`@pilleo/paperclip-adapter-common`](packages/common) | `0.1.0` | Shared codecs, logging interfaces, and process runner utilities. |

---

## 🧪 Testing & Verification

```bash
# Run all unit tests across all packages
pnpm test

# Build all TypeScript packages
pnpm build
```
