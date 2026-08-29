# @pilleo/paperclip-jules-adapter

A robust Paperclip adapter for starting and orchestrating long-lived Google Jules developer agent sessions.

## Architecture

Google Jules sessions can run for days, executing complex coding tasks. Paperclip's orchestration model uses a bounded heartbeat system. This adapter implements that model by executing long-running Google Jules sessions across multiple small Paperclip heartbeats, persisting and resuming orchestration state cleanly between intervals.

### How it works
1. **Start**: The adapter maps a Paperclip task and prompt into a new Jules session.
2. **Durable checkpoint**: Immediately after creating a Jules session, it returns a pending continuation so Paperclip persists the provider session ID before any long wait.
3. **Long polling**: Resumed runs poll every five minutes and remain attached for up to six hours. If Jules is still active, the adapter returns a durable transient continuation rather than a successful completion.
4. **Resumption**: Paperclip resumes the adapter later, injecting the durable state. If Paperclip drops that state after a host configuration change, the adapter recovers the original session from Jules by Paperclip issue marker and repository before it is allowed to create another session.
5. **Activity bridge**: New Jules agent messages, generated plans, and progress updates are mirrored to the Paperclip issue thread with the Jules activity ID. User-message echoes and terminal/provider bookkeeping activities are not copied.
6. **Two-way decisions**: A Jules question creates a Paperclip reply card; its free-text answer is sent to Jules with `sendMessage`. A generated plan creates a Paperclip approval card; acceptance calls Jules `approvePlan`, while rejection keeps the issue blocked for manual Jules follow-up. Ordinary Paperclip comments are not forwarded to avoid accidental instructions.
7. **Completion**: If Jules completes and creates a PR, the adapter moves the Paperclip issue to `in_review` and clears the completed Jules session from its active/recovery state. If Jules completes without a PR, the adapter blocks the issue and creates an idempotent Paperclip confirmation. Accepting it marks the issue `done`; rejecting it leaves the issue `blocked`. Either decision clears the terminal Jules session so the confirmation cannot accidentally start another Jules task.
8. **Reopening**: Reopening an issue after a PR-backed completion starts a new Jules task from the issue's current title and description; terminal Jules sessions are not resumed.
9. **Recovery**: Network transient failures, crashes, and 500s trigger a reliable backoff continuation without failing the task. Exhausted retries request human intervention via interaction blocks.

## Setup Instructions

### Paperclip secret binding

The adapter requires `JULES_API_KEY` to securely access the Google Jules API. Create the Paperclip shared secret with the normalized key `jules-api-key`, then bind it directly to the Jules agent at `env.JULES_API_KEY`.

`jules-api-key` is the Paperclip secret-record key. `JULES_API_KEY` is the runtime environment-variable name; it must use underscores because environment variable names cannot contain dashes.

Paperclip resolves the binding into the adapter runtime for each run. The key must not be put in the Jules adapter configuration, issue overrides, prompts, or the Paperclip server process environment.

The adapter deliberately does not fall back to `process.env.JULES_API_KEY`; a missing binding produces a diagnostic explaining how to create it.

### Heartbeat requirement

After a plan-approval interaction is accepted, the adapter relays `approvePlan` and
the session enters its long RUNNING phase. Polling during that phase depends on
Paperclip waking the agent: either enable `runtimeConfig.heartbeat`
(e.g. `intervalSec: 300`) on the Jules agent, or ensure another mechanism sends
`POST /api/agents/:id/heartbeat/invoke`. With heartbeat **disabled** and no external
wake, completed sessions are never observed — the issue silently stays blocked
(observed live 2026-08-25, issue #9).

### Paperclip UI Registry Integration

This adapter acts as an **External Adapter** using Paperclip's dynamic external configuration capabilities.

The server plugin loader (`createServerAdapter()`) automatically provides the required declarative interface schema (`getConfigSchema`) to Paperclip's backend via `GET /api/adapters/jules/config-schema`.

When correctly installed on your Paperclip server instance, the UI will dynamically render the configuration form for:
- Jules source
- Repository allowlist
- Base branch
- Automation and retry policy; Jules polling timing is intentionally fixed.

*Note:* You do **not** need to manually patch Paperclip UI or implement React `ConfigFields` yourself.

## Current Alpha Limitations
* Rejected Jules plans cannot currently be sent back to Jules as a structured rejection because the Jules API exposes plan approval but no plan-rejection endpoint. The Paperclip issue remains blocked; the rejection and its reason stay on the Paperclip interaction for manual Jules follow-up.

## Development Requirements
- Node 22
- `pnpm`
- Vitest

## Validation
```sh
npm run typecheck
npm test
npm run build
```
