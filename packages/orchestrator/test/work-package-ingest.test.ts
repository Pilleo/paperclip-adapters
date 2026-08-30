import { describe, it, expect } from "vitest";
import {
  inferTargetFilesFromSymbols,
  needsWorkPackageFill,
  symbolFileStems,
} from "../src/core/work-package-ingest.js";

describe("work-package ingest", () => {
  it("needs fill when target_files are missing", () => {
    expect(needsWorkPackageFill({ target_symbols: ["Foo"] })).toBe(true);
    expect(needsWorkPackageFill({ target_files: ["enforcer/src/Foo.kt"] })).toBe(false);
  });

  it("derives file stems from language-agnostic symbol spellings", () => {
    expect(symbolFileStems("SandboxDispatcher#dispatch")).toEqual(
      expect.arrayContaining(["SandboxDispatcher", "sandbox_dispatcher", "sandbox-dispatcher"])
    );
    expect(symbolFileStems("pkg::Foo::new")).toEqual(expect.arrayContaining(["new", "Foo"]));
  });

  it("infers kotlin, typescript, python, go, and rust paths from the same symbol rules", () => {
    const tree = [
      "enforcer/src/main/kotlin/io/mazewall/SandboxDispatcher.kt",
      "packages/foo/src/sandboxDispatcher.ts",
      "lib/sandbox_dispatcher.py",
      "cmd/sandbox_dispatcher.go",
      "crates/core/src/sandbox_dispatcher.rs",
      "unrelated/Other.kt",
    ];
    const files = inferTargetFilesFromSymbols(["SandboxDispatcher#dispatch"], "/ws", () => tree);
    expect(files).toEqual([
      "enforcer/src/main/kotlin/io/mazewall/SandboxDispatcher.kt",
      "packages/foo/src/sandboxDispatcher.ts",
      "lib/sandbox_dispatcher.py",
      "cmd/sandbox_dispatcher.go",
      "crates/core/src/sandbox_dispatcher.rs",
    ]);
  });

  it("accepts path-like symbols with any source extension", () => {
    const files = inferTargetFilesFromSymbols(
      ["src/handlers.ts"],
      "/ws",
      () => ["src/handlers.ts", "src/handlers.test.ts"]
    );
    expect(files).toContain("src/handlers.ts");
  });
});
