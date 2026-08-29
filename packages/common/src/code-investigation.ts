import fs from "node:fs";
import path from "node:path";

export interface FileOutline {
  readonly filePath: string;
  readonly fileName: string;
  readonly outlineText: string;
  readonly methodCount: number;
  readonly classCount: number;
}

export interface LogFailureWindow {
  readonly failedTestName?: string | undefined;
  readonly failureContext: string;
  readonly totalLogLines: number;
  readonly isTruncated: boolean;
}

/**
 * Native, zero-dependency TypeScript structural file outliner.
 * Extracts class and function declarations across languages (Kotlin, Java, TS/JS, Go, Rust, Python)
 * without requiring any external language runtime or CLI.
 */
export function outlineFileStructure(
  filePath: string,
  workspaceRoot?: string
): FileOutline {
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

  const content = fs.readFileSync(resolvedPath, "utf-8");
  const rawLines = content.split("\n");
  const outlineLines: string[] = [`Structure of ${fileName}:`, "=".repeat(fileName.length + 14)];

  let methodCount = 0;
  let classCount = 0;

  for (let idx = 0; idx < rawLines.length; idx++) {
    const line = rawLines[idx]!.trim();
    if (
      line.startsWith("//") ||
      line.startsWith("/*") ||
      line.startsWith("*") ||
      line.startsWith("#") ||
      line.startsWith("import ") ||
      line.startsWith("package ") ||
      line.startsWith("use ")
    ) {
      continue;
    }

    // Class / Struct / Interface / Type definitions
    if (
      line.includes("class ") ||
      line.includes("interface ") ||
      line.includes("struct ") ||
      line.includes("trait ") ||
      line.includes("object ") ||
      line.includes("enum class ") ||
      line.startsWith("type ")
    ) {
      outlineLines.push(`  [TYPE] L${idx + 1}: ${line.split("{")[0]!.trim()}`);
      classCount++;
    }
    // Method / Function definitions
    else if (
      line.startsWith("fun ") ||
      line.startsWith("public fun ") ||
      line.startsWith("private fun ") ||
      line.startsWith("protected fun ") ||
      line.startsWith("internal fun ") ||
      line.startsWith("override fun ") ||
      line.startsWith("def ") ||
      line.startsWith("fn ") ||
      line.startsWith("pub fn ") ||
      line.startsWith("function ") ||
      line.startsWith("export function ") ||
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
 * Extracts a complete, un-sanitized failure context window (nested stack trace,
 * root cause, and surrounding error logs) rather than an overly simplistic regex snippet.
 */
export function extractFailureContextWindow(rawLog: string, maxWindowLines: number = 80): LogFailureWindow {
  const lines = rawLog.split("\n");
  let failureStartIndex = -1;
  let failedTestName: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    if (line.includes("FAILED") || line.includes("FAILURE") || line.includes("FAIL:") || line.includes("AssertionError") || line.includes("Exception in thread")) {
      failureStartIndex = i;
      const match = line.match(/(?:Test\s+|test\s+|>\s+)?([a-zA-Z0-9_$.]+(?:Test|Spec|IT)?\.[a-zA-Z0-9_$]+)/);
      if (match && match[1]) {
        failedTestName = match[1];
      }
      break;
    }
  }

  if (failureStartIndex === -1) {
    // If no explicit failure marker, retain the tail of the log (last maxWindowLines)
    const tailLines = lines.slice(-maxWindowLines);
    return Object.freeze({
      failedTestName: undefined,
      failureContext: tailLines.join("\n"),
      totalLogLines: lines.length,
      isTruncated: lines.length > maxWindowLines,
    });
  }

  // Include 5 lines of prelude before the failure and up to maxWindowLines of full stack trace
  const start = Math.max(0, failureStartIndex - 5);
  const end = Math.min(lines.length, start + maxWindowLines);
  const window = lines.slice(start, end).join("\n");

  return Object.freeze({
    failedTestName,
    failureContext: window,
    totalLogLines: lines.length,
    isTruncated: lines.length > maxWindowLines,
  });
}
