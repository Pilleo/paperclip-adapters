# Jules feedback: API required-plan-approval session becomes terminal on UI timer

Submission channel: use **Feedback** in the signed-in Jules web app, as documented at https://jules.google/docs/feedback/. The Jules REST API does not expose a feedback submission endpoint. Do not paste an API key, session prompt, private repository content, or manifest file into the form.

## Pasteable report

**Subject:** How can API-created sessions keep `requirePlanApproval: true` pending for sequential structured reviews?

We use `POST /v1alpha/sessions` with `requirePlanApproval: true` and review the generated plan through two independent, addressed Paperclip reviewer cards before calling `sessions.approvePlan`. The REST API says this flag requires explicit plan approval before work. The Jules planning guide also says Jules eventually auto-approves on a timer if the user navigates away. Is that timer applied to API sessions? Is there a supported API option to disable or extend it, and can `sessions.approvePlan` be called after the aggregate state becomes `COMPLETED` without a `planApproved` activity?

Two marked direct API controls on the same disposable repository reproduced the transition without Paperclip:

| Jules session | `requirePlanApproval` | Automation | Result |
|---|---|---|---|
| `8408476216211861987` | `true` | `AUTO_CREATE_PR` | 11 `AWAITING_PLAN_APPROVAL` observations, then `COMPLETED` at `2026-09-27T00:18:01.753343Z` |
| `2291312700283024707` | `true` | `AUTOMATION_MODE_UNSPECIFIED` | 12 `AWAITING_PLAN_APPROVAL` observations, then `COMPLETED` at `2026-09-27T01:18:10.436825Z` |

Neither control called `approvePlan` or `sendMessage`; both showed only `planGenerated` activity and no session output on repeated terminal reads. The serialized request flag was tested at the Jules client transport boundary and recorded in owner-only pre-POST manifests. A separate typed rejection was successfully sent once to an already-completed session; Jules echoed it and generated a revised plan in the **same session**, but that plan also later became `COMPLETED` without an approval call.

Please clarify whether this is expected API behavior, whether the timer can be controlled, and which provider evidence distinguishes a timed auto-approval from an explicitly approved immutable plan revision. We need to avoid falsely accepting a review decision after the session has moved to a terminal state.

Internal evidence: `docs/superpowers/evidence/2026-09-27-jules-plan-approval.md`. Local manifests under `/tmp/paperclip-jules-approval-qualification*.json` contain only sanitized request/observation metadata and are not attachments.
