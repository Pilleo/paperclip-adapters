import { z } from "zod";
import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { THINKING_LEVELS, DEFAULT_VIBE_MODEL } from "./models.js";

export const DEFAULT_VIBE_COMMAND = "vibe --acp";

export const VibeConfigSchema = z.object({
  serverCommand: z.string().optional().default(DEFAULT_VIBE_COMMAND),
  model: z.string().optional().default(DEFAULT_VIBE_MODEL),
  thinking: z.enum(THINKING_LEVELS).optional().default("high"),
  permissionMode: z.string().optional().default("approve-all"),
  cwd: z.string().optional(),
  promptTemplate: z.string().optional(),
  timeoutSec: z.number().int().positive().optional().default(300),
  env: z.record(z.string(), z.string()).optional().default({}),
});

export type VibeConfig = z.infer<typeof VibeConfigSchema>;

export const vibeAdapterConfigSchema: AdapterConfigSchema = {
  fields: [
    {
      key: "thinking",
      label: "Thinking Level",
      type: "select",
      required: false,
      options: [
        { label: "High (Recommended)", value: "high" },
        { label: "Medium", value: "medium" },
        { label: "Low", value: "low" },
        { label: "Max", value: "max" },
        { label: "Off (No reasoning)", value: "off" },
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
