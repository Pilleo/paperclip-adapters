# Failure Recovery

The adapter implements robust recovery handling for transient crashes, task issues, or API failures using predefined classifications.

## Error Classifications
- **Transient**: Status `429`, `5xx`, and standard networking/fetch errors.
- **Configuration**: Status `401`, `403` or mismatched API tokens.
- **Task**: Bad configurations (`400`), incorrect parameter payloads.
- **Unknown**: Fallback for ambiguous API returns.

## Retry Policy
- Transient errors allow up to 3 automatic retries by creating a brand new Jules session referencing the previous failure.
- Unknown errors allow up to 1 retry.
- Configuration and Task errors do not retry, requiring manual intervention.

## Retry Mechanics
When a retry is invoked, the adapter logs the crash to the previous session in an internal `failedSessions` array. It returns an explicit `exitCode: 1` alongside a schedule `retryNotBefore` timestamp. When Paperclip awakens it again, the state machine detects `RETRY_SCHEDULED`, generates a clean contextual prompt referencing the crash, and submits it to a fresh Jules session gracefully.
