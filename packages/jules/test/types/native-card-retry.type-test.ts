import { retryStartedEffect, type LifecycleEffectJournal } from "../../src/server/lifecycle-effect-journal.js";
import type { NativePlanEffectReconciliation } from "../../src/server/native-plan-effect-reconciler.js";

declare const journal: LifecycleEffectJournal;

// @ts-expect-error A bare effect ID is not authorization to replay an interrupted mutation.
retryStartedEffect(journal, "card:terra:rev-1", "2026-09-20T00:01:00Z");

// @ts-expect-error A retry-safe response must carry validated native-card retry evidence.
const proofless: NativePlanEffectReconciliation = { kind: "retry_safe" };
void proofless;
