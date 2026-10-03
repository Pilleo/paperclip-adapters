# @pilleo/paperclip-antigravity-adapter

Paperclip adapter plugin for Google Antigravity (AGY) ACP Server.

## Provider permission modes

The adapter maps `read-only` and `prompt-on-write` to the ACP engine's canonical
`approve-reads` policy. In headless execution, write permission requests are
denied unless another explicitly configured permission mechanism resolves them.
`approve-all`, `approve-reads` and `deny-all` are preserved. An omitted mode keeps
the documented `approve-all` default; unknown values fail before provider startup.

This controls ACP permission requests; it is separate from native Paperclip
review authority and filesystem sandboxing. The real-host
`acp-permissions-live.mjs` contract observes the read/write decisions on both
baseline and candidate control-plane versions.
