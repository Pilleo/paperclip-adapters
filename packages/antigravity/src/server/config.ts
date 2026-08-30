import { z } from "zod";
import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export function defaultAgyServerPath(): string {
  return process.env["ANTIGRAVITY_ACP_SERVER"] || process.env["AGY_ACP_SERVER"] || "agy";
}

export const DEFAULT_AGY_SERVER_PATH = defaultAgyServerPath();

export const AntigravityConfigSchema = z.object({
  serverPath: z.string().optional().default(DEFAULT_AGY_SERVER_PATH),
  uid: z.string().optional().default(""),
  debug: z.boolean().optional().default(false),
  model: z.string().optional().default("gemini-pro-agent"),
  cwd: z.string().optional(),
  promptTemplate: z.string().optional(),
  timeoutSec: z.number().int().positive().optional().default(300),
  permissionMode: z.string().optional().default("approve-all"),
});

export type AntigravityConfig = z.infer<typeof AntigravityConfigSchema>;

export const antigravityAdapterConfigSchema: AdapterConfigSchema = {
  fields: [
    {
      key: "debug",
      label: "Debug Logging",
      type: "select",
      required: false,
      options: [
        { label: "Disabled", value: "false" },
        { label: "Enabled", value: "true" },
      ],
    },
    {
      key: "permissionMode",
      label: "Permission Mode",
      type: "select",
      required: false,
      options: [
        { label: "Approve All (Headless)", value: "approve-all" },
        { label: "Approve Reads Only", value: "approve-reads" },
      ],
    },
  ],
};
