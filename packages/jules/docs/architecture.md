# Architecture

The Jules adapter acts as a stateful bridge between Paperclip's bounded execution model and Google's asynchronous Jules API.

## Core Flow

1. **Initialization:** A task comes in from Paperclip. The adapter validates credentials and generates a deterministic prompt combining instructions, issue information, branch and repository details.
2. **Session Creation:** The adapter invokes Jules to create a new async task session.
3. **Heartbeat Polling Loop:** The adapter executes within Paperclip's bounded heartbeat window (default 120s). Inside this loop, it periodically checks the Jules session state.
4. **State Transitions:**
   - Non-terminal operations (like `QUEUED`, `IN_PROGRESS`) keep the adapter alive inside its loop until the window closes.
   - Requires feedback (`AWAITING_USER_FEEDBACK`, `AWAITING_PLAN_APPROVAL`) results in returning early and generating a Paperclip interaction to halt the session safely.
   - On resumption with answers, the adapter pushes the decision back to Jules via `sendMessage` or `approvePlan` and resumes polling.
   - Terminal success or failure will trigger final artifact links or standard task failures.
5. **Persistence:** The internal session metadata `JulesAdapterSessionV1` is persisted directly using the `AdapterSessionCodec` interface so that any crash or long-day session parking maintains correct orchestrator state.

## Rules
- An adapter process must not sleep indefinitely. It bounds its work using `setTimeout` constrained by `AbortSignal` inputs and max heartbeat deadlines.
