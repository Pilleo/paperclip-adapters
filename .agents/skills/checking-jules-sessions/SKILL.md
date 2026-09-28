---
name: checking-jules-sessions
description: Use when asked what a live Google Jules provider session is doing, whether it is awaiting plan approval, or when Paperclip's adapter state is insufficient evidence of Jules activity.
---

# Checking Jules sessions

Use the **direct Jules API** for provider state and activity evidence. The helper reads only `JULES_API_KEY` from the ignored, uppercase project `.ENV` file into memory. Its permissions must be owner-only (`chmod 600 .ENV`). It sends the key only in the `X-Goog-Api-Key` header to the fixed Jules HTTPS host; requests are GET-only and redirects are refused. Never source `.ENV` in a shell, pass the key in argv, or print raw responses.

```bash
python3 .agents/skills/checking-jules-sessions/scripts/jules_api.py 13925655926969425884 --contains-feedback 'Please revise the plan'
```

Output includes the exact session state, update time, activity kinds/timestamps and, when requested, whether a phrase occurs in a Jules `userMessaged` activity. It omits message bodies, plan text, unrelated `.ENV` entries, the API key, and HTTP error bodies. If `feedbackSeenInUserMessage` is false, report only that no matching activity appeared in the complete returned activity history, not that no message was ever delivered by another channel.

When only a keyless, limited overview is needed, use `scripts/jules_status.py SESSION_ID`: it calls the authenticated official CLI and returns a potentially truncated status label. Prefer the direct API for questions about Jules activity; never substitute Paperclip's adapter heartbeat for the provider state.

Never use `jules new`, `jules remote pull`, `jules teleport`, `:sendMessage`, or `:approvePlan` when inspecting a session. Never place an API key in command arguments, a URL, a repo file, or a tool response.
