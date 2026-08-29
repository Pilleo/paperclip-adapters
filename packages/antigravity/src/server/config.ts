import { z } from "zod";
import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export const DEFAULT_AGY_SERVER_PATH =
  "/home/leanid/.local/share/zed/external_agents/registry/antigravity-acp/v_1.0.0_92521fc3cbd964bd_fc45337c399e4ef2/agy_acp_server.par";

export const AntigravityConfigSchema = z.object({
  serverPath: z.string().optional().default(DEFAULT_AGY_SERVER_PATH),
  uid: z.string().optional().default(""),
  debug: z.boolean().optional().default(false),
  model: z.string().optional().default("gemini-3.7-flash-high"),
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
