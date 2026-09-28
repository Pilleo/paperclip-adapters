/** Only configured, visible Jules plan fields can require a follow-up PATCH. */
export function needsJulesPlanPolicyPatch(
  current: Readonly<Record<string, unknown>> | null | undefined,
  desired: Readonly<{
    planApprovalPolicy?: string | undefined;
    planReviewerAgentId?: string | undefined;
    planStrongReviewerAgentId?: string | undefined;
    questionReviewerAgentId?: string | undefined;
    questionAdjudicatorAgentId?: string | undefined;
  }>,
): boolean {
  return Object.entries(desired).some(([key, value]) =>
    value !== undefined && value !== "" && current?.[key] !== value
  );
}
