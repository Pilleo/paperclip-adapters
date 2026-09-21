# Compatibility

This adapter implements support for Paperclip interactions and builds on its SDK packages.

## Tested Environment

- **Paperclip host version**: `2026.916.0`
- **Tested commit**: local Paperclip `398261539`

## Relevant Contracts

- `packages/adapter-utils/src/types.ts`
- `server/src/services/heartbeat.ts`
- `server/src/services/recovery/`
- `.agents/skills/create-agent-adapter/SKILL.md`

## Jules API

- Version: `v1alpha`

## SDK Dependencies

- `@paperclipai/adapter-utils`: `2026.916.0`

## v2026.916.0 integration notes

- Paperclip resolves adapter `secret_ref` bindings before each run; the Jules
  provider credential remains `env.JULES_API_KEY`.
- Paperclip's GitHub connector injects a run-scoped `git`/`gh` launcher into
  the resolved run environment. The adapter forwards that environment for PR
  inspection and treats launcher failures as an explicit unavailable state.
- `modelProfiles` and `AdapterModelProfileDefinition` were removed upstream.
  Local ACP adapters expose their model catalogs only through supported model
  fields and discovery methods.
- Jules is not an AI Connection provider in this release. It continues to use
  its provider API key rather than an unsupported generic connection or MCP
  credential bridge.
