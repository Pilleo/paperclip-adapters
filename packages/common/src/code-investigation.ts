import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FileOutline {
  readonly filePath: string;
  readonly fileName: string;
  readonly outlineText: string;
  readonly methodCount: number;
  readonly classCount: number;
}

export interface CompactLogEvidence {
  readonly failedTestName?: string | undefined;
  readonly errorType?: string | undefined;
  readonly errorLocation?: string | undefined;
  readonly rootCauseSnippet: string;
  readonly totalLinesCompacted: number;
}

/**
 * Generates a compact structural outline of a source file using file_structure script or regex parser.
 * Consumes ~50-100 tokens instead of 5,000+ tokens for full file content.
 */
export async function outlineFileStructure(
  filePath: string,
  workspaceRoot?: string
): Promise<FileOutline> {
  const resolvedPath = workspaceRoot ? path.resolve(workspaceRoot, filePath) : filePath;
  const fileName = path.basename(filePath);

  if (!fs.existsSync(resolvedPath)) {
    return {
      filePath,
      fileName,
      outlineText: `File not found: ${filePath}`,
      methodCount: 0,
      classCount: 0,
    };
  }

  // 1. Try Kotlin script if available
  const scriptPath = workspaceRoot ? path.resolve(workspaceRoot, "scripts/file_structure.main.kts") : null;
  if (scriptPath && fs.existsSync(scriptPath)) {
    try {
      const { stdout } = await execFileAsync("kotlin", [scriptPath, resolvedPath], {
        timeout: 5000,
        cwd: workspaceRoot,
      });
      const lines = stdout.trim().split("\n");
      const methodCount = lines.filter((l) => l.includes("fun ") || l.includes("def ") || l.includes("fn ")).length;
      const classCount = lines.filter((l) => l.includes("class ") || l.includes("interface ") || l.includes("object ")).length;
      return {
        filePath,
        fileName,
        outlineText: stdout.trim(),
        methodCount,
        classCount,
      };
    } catch {
      // Fallback to pure TS regex parser
    }
  }

  // 2. Pure TS regex structural outline parser (fast & zero-subprocess fallback)
  const content = fs.readFileSync(resolvedPath, "utf-8");
  const rawLines = content.split("\n");
  const outlineLines: string[] = [`Structure of ${fileName}:`, "=".repeat(fileName.length + 14)];

  let methodCount = 0;
  let classCount = 0;

  for (let idx = 0; idx < rawLines.length; idx++) {
    const line = rawLines[idx]!.trim();
    if (line.startsWith("//") || line.startsWith("/*") || line.startsWith("*") || line.startsWith("import ") || line.startsWith("package ")) {
      continue;
    }

    if (
      line.includes("class ") ||
      line.includes("interface ") ||
      line.includes("object ") ||
      line.includes("enum class ")
    ) {
      outlineLines.push(`  [CLASS] L${idx + 1}: ${line.split("{")[0]!.trim()}`);
      classCount++;
    } else if (
      line.startsWith("fun ") ||
      line.startsWith("public fun ") ||
      line.startsWith("private fun ") ||
      line.startsWith("protected fun ") ||
      line.startsWith("internal fun ") ||
      line.startsWith("override fun ") ||
      line.startsWith("public void ") ||
      line.startsWith("public static ")
    ) {
      outlineLines.push(`    [METHOD] L${idx + 1}: ${line.split("{")[0]!.split("=")[0]!.trim()}`);
      methodCount++;
    }
  }

  return {
    filePath,
    fileName,
    outlineText: outlineLines.join("\n"),
    methodCount,
    classCount,
  };
}

/**
 * Compacts massive build/test failure logs into a surgical, token-efficient 3-5 line Evidence Packet.
 * Avoids dumping megabytes of logs into expensive model context windows.
 */
export function compactLargeLogToEvidence(rawLog: string): CompactLogEvidence {
  const lines = rawLog.split("\n");
  let failedTestName: string | undefined;
  let errorType: string | undefined;
  let errorLocation: string | undefined;
  const criticalLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    // Match failed test names
    if (!failedTestName && (line.includes("FAILED") || line.includes("FAILURE") || line.includes("FAIL:"))) {
      const match = line.match(/(?:Test\s+|test\s+|>\s+)?([a-zA-Z0-9_$.]+(?:Test|Spec|IT)?\.[a-zA-Z0-9_$]+)/);
      if (match && match[1]) {
        failedTestName = match[1];
      }
    }

    // Match exception types and assertion errors
    if (!errorType && (line.includes("Exception:") || line.includes("Error:") || line.includes("AssertionError"))) {
      errorType = line.slice(0, 120);
      criticalLines.push(line);
    }

    // Match stack trace locations in project code
    if (!errorLocation && line.includes("at ") && (line.includes("io.mazewall") || line.includes("src/"))) {
      errorLocation = line.slice(0, 120);
      criticalLines.push(line);
    }
  }

  const snippet = [
    failedTestName ? `💥 Failing Test: ${failedTestName}` : null,
    errorType ? `🚨 Root Error: ${errorType}` : null,
    errorLocation ? `📍 Code Location: ${errorLocation}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return Object.freeze({
    failedTestName,
    errorType,
    errorLocation,
    rootCauseSnippet: snippet || (rawLog.length > 500 ? `${rawLog.slice(0, 500)}...` : rawLog),
    totalLinesCompacted: lines.length,
  });
}
