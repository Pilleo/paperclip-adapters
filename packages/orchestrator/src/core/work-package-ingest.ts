import fs from "node:fs";
import path from "node:path";

export interface WorkPackageFields {
  readonly targetFiles: readonly string[];
  readonly targetSymbols: readonly string[];
  readonly exclusive?: boolean | undefined;
}

/** Source-like extensions across common languages; not Kotlin/Java only. */
export const SOURCE_FILE_EXTENSIONS = Object.freeze([
  ".kt",
  ".kts",
  ".java",
  ".scala",
  ".groovy",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".rb",
  ".swift",
  ".m",
  ".mm",
  ".php",
  ".zig",
  ".lua",
  ".r",
  ".jl",
  ".ex",
  ".exs",
  ".hs",
  ".ml",
  ".fs",
  ".vue",
  ".svelte",
]);

const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "build",
  "dist",
  "target",
  "out",
  "coverage",
  "vendor",
  "venv",
  ".venv",
  "__pycache__",
  ".gradle",
  ".idea",
  ".paperclip",
]);

export function needsWorkPackageFill(fields: Record<string, unknown>): boolean {
  const files = fields["target_files"];
  const hasFiles = Array.isArray(files) ? files.length > 0 : typeof files === "string" && files.trim().length > 0;
  return !hasFiles;
}

function toSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[.-]/g, "_")
    .toLowerCase();
}

function toKebab(name: string): string {
  return toSnake(name).replace(/_/g, "-");
}

function addIdentStems(stems: Set<string>, ident: string): void {
  const clean = ident.replace(/[()<>]/g, "").trim();
  if (!clean) return;
  stems.add(clean);
  stems.add(clean.toLowerCase());
  stems.add(toSnake(clean));
  stems.add(toKebab(clean));
}

/** Bare identifiers from Foo#bar, pkg.Foo.bar, Foo::bar, paths, or a path-like token. */
export function symbolFileStems(raw: string): string[] {
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (!trimmed) return [];

  const stems = new Set<string>();
  if (isSourceFile(trimmed) || (trimmed.includes("/") && isSourceFile(path.basename(trimmed)))) {
    addIdentStems(stems, path.basename(trimmed, path.extname(trimmed)));
    return [...stems];
  }

  let ident = trimmed;
  if (ident.includes("#")) ident = ident.split("#")[0] || ident;
  if (ident.includes("::")) {
    const segs = ident.split("::").filter(Boolean);
    const last = segs[segs.length - 1];
    const prev = segs.length > 1 ? segs[segs.length - 2] : undefined;
    if (last) addIdentStems(stems, last);
    if (prev && /^[A-Z_]/.test(prev)) addIdentStems(stems, prev);
    return [...stems];
  }
  if (ident.includes("/")) ident = ident.split("/").pop() || ident;
  if (ident.includes(".")) {
    const parts = ident.split(".");
    const last = parts[parts.length - 1] || ident;
    const maybeType = parts.length > 1 ? parts[parts.length - 2] : last;
    ident = /^[a-z]/.test(last) && maybeType ? maybeType : last;
  }
  addIdentStems(stems, ident);
  return [...stems];
}

function fileStem(rel: string): string {
  return path.basename(rel, path.extname(rel));
}

function isSourceFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return (SOURCE_FILE_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * When YAML omits target_files, infer source paths from declared symbols in any language.
 * Cached by the caller via markdown mtime.
 */
export function inferTargetFilesFromSymbols(
  symbols: readonly string[],
  workspacePath: string,
  walkFn: (dir: string) => string[] = listSourceFiles
): string[] {
  if (!workspacePath || symbols.length === 0) return [];

  const directPaths = symbols
    .map((s) => s.trim().replace(/\\/g, "/"))
    .filter((s) => s.includes("/") && isSourceFile(s));

  let sources: string[] = [];
  try {
    sources = walkFn(workspacePath);
  } catch {
    return [...directPaths];
  }

  const found: string[] = [];
  const push = (rel: string) => {
    const normalized = rel.replace(/\\/g, "/");
    if (!found.includes(normalized)) found.push(normalized);
  };

  for (const p of directPaths) {
    if (sources.includes(p) || sources.some((s) => s.replace(/\\/g, "/") === p)) push(p);
  }

  const stemSets = symbols.map((s) => new Set(symbolFileStems(s).map((x) => x.toLowerCase())));

  for (const rel of sources) {
    const stem = fileStem(rel).toLowerCase();
    const base = path.basename(rel).toLowerCase();
    for (const stems of stemSets) {
      if (stems.has(stem) || stems.has(base)) {
        push(rel);
        break;
      }
    }
  }
  return found;
}

export function listSourceFiles(workspacePath: string, maxFiles = 8000, maxDepth = 12): string[] {
  const out: string[] = [];
  const visit = (abs: string, rel: string, depth: number) => {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      if (ent.isDirectory() && SKIP_DIR_NAMES.has(ent.name)) continue;
      const childAbs = path.join(abs, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) visit(childAbs, childRel, depth + 1);
      else if (isSourceFile(ent.name)) out.push(childRel.replace(/\\/g, "/"));
    }
  };
  visit(workspacePath, "", 0);
  return out;
}

const ingestCache = new Map<string, { mtimeMs: number; files: readonly string[] }>();

export function cachedInferTargetFiles(
  cacheKey: string,
  mtimeMs: number,
  symbols: readonly string[],
  workspacePath: string
): readonly string[] {
  const hit = ingestCache.get(cacheKey);
  if (hit && hit.mtimeMs === mtimeMs) return hit.files;
  const files = inferTargetFilesFromSymbols(symbols, workspacePath);
  ingestCache.set(cacheKey, { mtimeMs, files });
  return files;
}
