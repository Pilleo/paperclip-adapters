import { describe, it, expect } from "vitest";
import manifest from "../src/manifest.js";

describe("Paperclip Plugin Manifest", () => {
  it("defines valid Paperclip plugin metadata", () => {
    expect(manifest.id).toBe("telegram");
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.categories).toContain("connector");
    expect(manifest.categories).toContain("automation");
    expect(manifest.entrypoints.worker).toBe("./dist/worker.js");
  });

  it("declares necessary host capabilities including secrets.read-ref", () => {
    expect(manifest.capabilities).toContain("companies.read");
    expect(manifest.capabilities).toContain("issues.read");
    expect(manifest.capabilities).toContain("approvals.read");
    expect(manifest.capabilities).toContain("approvals.respond");
    expect(manifest.capabilities).toContain("secrets.read-ref");
  });

  it("exposes clean non-secret config focusing on chatId (TELEGRAM_CHAT_ID)", () => {
    const props = manifest.instanceConfigSchema.properties as Record<string, any>;
    expect(props["botToken"]).toBeUndefined();
    expect(props["allowedUserIds"]).toBeUndefined();
    expect(props["chatId"]).toBeDefined();
    expect(manifest.instanceConfigSchema.required).toContain("chatId");
  });
});
