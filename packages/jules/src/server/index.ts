import { execute } from "./execute.js";
import { testEnvironment } from "./test-environment.js";
import { AdapterConfigSchema } from "./config.js";
import { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { sessionCodec } from "./session.js";
import { julesConfigSchema } from "./config-schema.js";

export const type = "jules";
export const label = "Google Jules";
export const models = [];

export {
  execute,
  testEnvironment,
  AdapterConfigSchema as configSchema
};
export { checkJulesCredentials, checkLocalState } from "./health.js";
export { createTelemetry, redactTelemetry } from "./telemetry.js";

export const julesAgentConfigurationDoc = `# Google Jules Adapter Setup & Configuration Guide

Google Jules is an asynchronous, cloud-native coding agent by Google that works independently in the background, creates GitHub pull requests, and iterates on CI tests.

---

## 📋 Prerequisites & Setup Checklist

To run Jules successfully, ensure the following 3 requirements are met:

### 1. 🔑 Obtain a Google Jules API Key
- Go to [Google Jules / AI Studio](https://jules.google) and generate an API Key.
- In Paperclip: Go to **Settings → Secrets**, create a secret named \`JULES_API_KEY\`, and bind it to this agent.

### 2. 🐙 Authorize the Google Jules GitHub App
- Jules operates directly against GitHub branches and pull requests.
- Install and authorize the **Google Jules GitHub App** on your target repository:
  👉 [https://github.com/apps/google-jules](https://github.com/apps/google-jules)
- Ensure the app has Read/Write permissions for Code, Pull Requests, and Issues.

### 3. 🎯 Configure Target Repository & Base Branch
- **Repository:** Specify the GitHub repository in format \`owner/repo\` (e.g. \`Pilleo/mazewall\`).
- **Base Branch:** The target default branch for pull requests (e.g. \`master\` or \`main\`).

---

## ⚙️ Key Configuration Options

| Option | Description | Recommended |
|---|---|---|
| **Repository** | Target GitHub \`owner/repo\` | Auto-detected from workspace |
| **Base Branch** | Target branch for PR creation | Auto-detected (e.g. \`master\`) |
| **Automation Mode** | \`AUTO_CREATE_PR\` | \`AUTO_CREATE_PR\` |
| **Plan Approval Policy** | \`required\` (requires human sign-off) or \`trusted_opt_out\` | \`trusted_opt_out\` |
| **Poll Cadence** | Checkpoint polling frequency (seconds) | \`300\` (5 minutes) |

---

## 🚨 Troubleshooting & Common Error Codes

| Error Symptom | Cause | Solution |
|---|---|---|
| **HTTP 401 / 403** | Invalid or missing \`JULES_API_KEY\` | Verify key in Paperclip Settings → Secrets → Secret Bindings. |
| **HTTP 404 on Session Create** | Target repo not connected to Jules | Install the GitHub App at [github.com/apps/google-jules](https://github.com/apps/google-jules). |
| **HTTP 429 Quota Exceeded** | 15 concurrent / 100 daily limit reached | The Orchestrator will automatically queue tasks until slots free up. |
`;

export function createServerAdapter(): ServerAdapterModule {
    return {
        type: "jules",
        execute,
        testEnvironment,
        sessionCodec,
        supportsLocalAgentJwt: true,
        models: [],
        agentConfigurationDoc: julesAgentConfigurationDoc,
        getConfigSchema: () => julesConfigSchema,
    };
}
