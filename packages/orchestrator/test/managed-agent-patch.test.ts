import { describe, expect, it } from "vitest";
import {
  decideManagedAgentPatch,
  managedConfigFingerprint,
  type ManagedAgentPatchDecision,
  type ManagedVisibleConfigDrift,
} from "../src/core/managed-agent-patch.js";

const desiredConfiguration = {
  adapterConfig: {
    env: { CODEX_HOME: "/managed/luna", PATH: "/usr/bin" },
    model: "gpt-5.6-luna",
  },
  runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
};

const desiredFingerprint = managedConfigFingerprint(desiredConfiguration);

type DecisionCase = Readonly<{
  name: string;
  observedName: string;
  observedFingerprint?: string;
  visibleConfigDrift: ManagedVisibleConfigDrift;
  expectedKind: ManagedAgentPatchDecision["kind"];
  expectedName: string | undefined;
}>;

describe("managed agent patch decision", () => {
  it.each<DecisionCase>([
    {
      name: "same name, same visible config, current fingerprint",
      observedName: "Luna",
      observedFingerprint: desiredFingerprint,
      visibleConfigDrift: "current",
      expectedKind: "unchanged",
      expectedName: undefined,
    },
    {
      name: "same name, stale visible config, current fingerprint",
      observedName: "Luna",
      observedFingerprint: desiredFingerprint,
      visibleConfigDrift: "stale",
      expectedKind: "patch",
      expectedName: undefined,
    },
    {
      name: "same name, redacted environment, current fingerprint",
      observedName: "Luna",
      observedFingerprint: desiredFingerprint,
      visibleConfigDrift: "current",
      expectedKind: "unchanged",
      expectedName: undefined,
    },
    {
      name: "same name, missing fingerprint",
      observedName: "Luna",
      visibleConfigDrift: "current",
      expectedKind: "patch",
      expectedName: undefined,
    },
    {
      name: "same name, stale fingerprint",
      observedName: "Luna",
      observedFingerprint: "0".repeat(64),
      visibleConfigDrift: "current",
      expectedKind: "patch",
      expectedName: undefined,
    },
    {
      name: "different name, otherwise current",
      observedName: "Legacy Luna",
      observedFingerprint: desiredFingerprint,
      visibleConfigDrift: "current",
      expectedKind: "patch",
      expectedName: "Luna",
    },
  ])("returns the expected decision for $name", (testCase) => {
    const decision = decideManagedAgentPatch({
      observed: {
        name: testCase.observedName,
        managedConfigFingerprint: testCase.observedFingerprint,
      },
      desired: {
        name: "Luna",
        configuration: desiredConfiguration,
        patch: {
          title: "Fast reviewer",
          adapterConfig: desiredConfiguration.adapterConfig,
          runtimeConfig: desiredConfiguration.runtimeConfig,
          metadata: { managedBy: "paperclip-orchestrator" },
        },
      },
      visibleConfigDrift: testCase.visibleConfigDrift,
    });

    expect(decision.kind).toBe(testCase.expectedKind);
    expect(decision.desiredFingerprint).toBe(desiredFingerprint);
    if (decision.kind === "patch") {
      expect(decision.patch["name"]).toBe(testCase.expectedName);
      expect(decision.patch.metadata["managedConfigFingerprint"]).toBe(desiredFingerprint);
    }
  });

  it("produces the same fingerprint for semantically equal objects with different key order", () => {
    expect(managedConfigFingerprint({ nested: { beta: 2, alpha: 1 }, top: true })).toBe(
      managedConfigFingerprint({ top: true, nested: { alpha: 1, beta: 2 } }),
    );
  });

  it("preserves array order in the managed configuration fingerprint", () => {
    expect(managedConfigFingerprint({ values: ["a", "b"] })).not.toBe(
      managedConfigFingerprint({ values: ["b", "a"] }),
    );
  });
});
