import { AdapterConfig, requireJulesApiKey, validateConfig } from "./config.js";
import { JulesClient } from "./jules-client.js";
import { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { sanitizeError } from "./error-sanitizer.js";
import { checkJulesCredentials, checkLocalState } from "./health.js";
import { sessionStoreDirectory } from "./session-store.js";

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const runtimeConfig = ctx.config || {};
  const config = runtimeConfig["adapterSchemaValues"] || runtimeConfig;

  let validatedConfig: AdapterConfig;
  let apiKey: string;
  try {
    validatedConfig = validateConfig(config);
    apiKey = requireJulesApiKey(runtimeConfig);
  } catch (err: unknown) {
    const diagnosticKeys = Object.keys(config).sort().join(", ") || "(none)";
    return {
      adapterType: "jules",
      status: "fail",
      testedAt: new Date().toISOString(),
      checks: [
        {
          code: "config_validation_failed",
          level: "error",
          message: `Jules adapter configuration is invalid. Received config keys: ${diagnosticKeys}. Details: ${sanitizeError(err)}`,
          hint: "Ensure JULES_API_KEY is bound in Company Settings -> Secrets and repository is configured.",
        },
      ],
    };
  }

  const client = new JulesClient(apiKey);

  const stateDirectory = sessionStoreDirectory();
  if (stateDirectory) {
    const localState = await checkLocalState(stateDirectory);
    if (!localState.ok) {
      return {
        adapterType: "jules",
        status: "fail",
        testedAt: new Date().toISOString(),
        checks: [
          {
            code: localState.code,
            level: "error",
            message: localState.message,
            hint: "Ensure the Paperclip process has read/write permissions for the local state directory.",
          },
        ],
      };
    }
  }

  const credentials = await checkJulesCredentials(client);
  if (!credentials.ok) {
    return {
      adapterType: "jules",
      status: "fail",
      testedAt: new Date().toISOString(),
      checks: [
        {
          code: credentials.code,
          level: "error",
          message: credentials.message,
          hint: "Verify your JULES_API_KEY is active and authorized for the Google Jules API.",
        },
      ],
    };
  }

  return {
    adapterType: "jules",
    status: "pass",
    testedAt: new Date().toISOString(),
    checks: [
      {
        code: "jules_credentials_ok",
        level: "info",
        message: "Google Jules API credentials and session connectivity verified successfully.",
        detail: null,
        hint: null,
      },
    ],
  };
}
