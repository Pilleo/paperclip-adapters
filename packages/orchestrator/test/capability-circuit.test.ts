import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CapabilityCircuit } from "../src/core/capability-circuit.js";

describe("CapabilityCircuit", () => {
  it("opens once for an authorization denial and stays open until an explicit successful probe", () => {
    const circuit = new CapabilityCircuit();
    expect(circuit.record("wake:jules-1", { ok: false, status: 403, text: "Agent can only invoke itself" })).toBe("opened");
    expect(circuit.isOpen("wake:jules-1")).toBe(true);
    expect(circuit.snapshot()).toEqual([{
      key: "wake:jules-1", status: 403, detail: "Agent can only invoke itself",
    }]);
    expect(circuit.record("wake:jules-1", { ok: false, status: 403, text: "same" })).toBe("already_open");
    expect(circuit.record("wake:jules-1", { ok: true, status: 202, text: "" })).toBe("closed");
    expect(circuit.isOpen("wake:jules-1")).toBe(false);
  });

  it("does not open for retryable or conflict responses", () => {
    const circuit = new CapabilityCircuit();
    expect(circuit.record("patch:issue-1", { ok: false, status: 500, text: "upstream" })).toBe("closed");
    expect(circuit.record("patch:issue-1", { ok: false, status: 409, text: "conflict" })).toBe("closed");
    expect(circuit.isOpen("patch:issue-1")).toBe(false);
  });

  it("persists a denied capability across circuit instances", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-circuit-"));
    try {
      const first = new CapabilityCircuit(stateDir);
      expect(first.record("fleet:company:luna", { ok: false, status: 403, text: "denied" })).toBe("opened");

      const second = new CapabilityCircuit(stateDir);
      expect(second.isOpen("fleet:company:luna")).toBe(true);
      expect(second.record("fleet:company:luna", { ok: false, status: 403, text: "denied again" })).toBe("already_open");
      expect(second.record("fleet:company:luna", { ok: true, status: 200, text: "authorized" })).toBe("closed");
      expect(new CapabilityCircuit(stateDir).isOpen("fleet:company:luna")).toBe(false);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
