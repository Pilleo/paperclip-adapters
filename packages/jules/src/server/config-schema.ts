import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export const julesConfigSchema: AdapterConfigSchema = {
  fields: [
    {
      key: "repository",
      label: "Repository",
      type: "text",
      required: false,
      hint: "Canonical owner/repo or GitHub URL. Omit when Paperclip workspace metadata provides it.",
    },
    {
      key: "baseBranch",
      label: "Base branch",
      type: "text",
      required: false,
      hint: "Omit to use the repository provider's default branch.",
    },
    {
      key: "automationMode",
      label: "Automation mode",
      type: "select",
      required: true,
      default: "AUTO_CREATE_PR",
      options: [
        {
          label: "Automatically create PR",
          value: "AUTO_CREATE_PR",
        }
      ],
    },
    {
      key: "planApprovalPolicy",
      label: "Plan approval policy",
      type: "select",
      required: true,
      default: "required",
      options: [
        { label: "Require approval", value: "required" },
        { label: "Trusted opt-out", value: "trusted_opt_out" },
      ],
    },
    {
      key: "retryBudget",
      label: "Retry budget",
      type: "number",
      required: true,
      default: 3,
    },
    {
      key: "prPolicy",
      label: "Pull request policy",
      type: "select",
      required: true,
      default: "auto",
      options: [
        { label: "Auto", value: "auto" },
        { label: "Always", value: "always" },
        { label: "Never", value: "never" },
      ],
    },
    {
      key: "sessionDeadlineMinutes",
      label: "Session deadline (minutes)",
      type: "number",
      required: false,
      default: 2880,
      hint: "Maximum lifetime before a Jules session is considered timed out (default: 2880 mins = 48 hours).",
    },
    {
      key: "progressVerbosity",
      label: "Progress verbosity",
      type: "select",
      required: true,
      default: "normal",
      options: [
        { label: "Quiet", value: "quiet" },
        { label: "Normal", value: "normal" },
        { label: "Verbose", value: "verbose" },
      ],
    },
  ],
};
