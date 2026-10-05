import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
const SHA = z.string().regex(/^[0-9a-f]{40}$/i);
const File = z.union([z.string(), z.object({ path: z.string(), changeType: z.string().optional() })]);
const Metadata = z.object({ url: z.string(), state: z.literal("OPEN"), headRefOid: SHA, baseRefOid: SHA,
  changedFiles: z.number().int().nonnegative(), files: z.array(File) });
const Comparison = z.object({ baseSha: SHA, mergeBaseSha: SHA, files: z.array(z.object({ path: z.string(), status: z.string() })) });
const COMPARISON_FIELDS = "{baseSha: .base_commit.sha, mergeBaseSha: .merge_base_commit.sha, files: [.files[] | {path: .filename, status}]}";
type ArtifactCode = "review_artifact_unavailable" | "review_artifact_head_changed" | "review_artifact_too_large";
export class NativeReviewArtifactError extends Error {
  constructor(readonly code: ArtifactCode) { super(code); }
}
export interface NativePullRequestArtifact {
  readonly complete: true;
  readonly headSha: string;
  readonly baseSha: string;
  readonly diff: string;
  readonly files: readonly { readonly path: string; readonly headContent: string | null }[];
}
type CommandOptions = { readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number; readonly maxBytes: number };
type Runner = (args: readonly string[], options: CommandOptions) => Promise<string>;

/** A scoped read snapshot, never a checkout operation or model shell permission. */
export async function readNativePullRequestArtifact(target: { readonly prUrl: string; readonly headSha: string },
  options: { readonly env?: NodeJS.ProcessEnv; readonly run?: Runner; readonly maxBytes?: number } = {}): Promise<NativePullRequestArtifact> {
  const url = /^https:\/\/github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/i.exec(target.prUrl);
  if (!url || !SHA.safeParse(target.headSha).success) throw new NativeReviewArtifactError("review_artifact_unavailable");
  const maxBytes = options.maxBytes ?? 512 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new NativeReviewArtifactError("review_artifact_unavailable");
  const env = options.env ?? process.env;
  const deadline = Date.now() + 12_000;
  const runner: Runner = options.run ?? (async (args, settings) => {
    const output = await exec(env["PAPERCLIP_GH_PATH"] || "gh", [...args], {
      env: settings.env, timeout: settings.timeoutMs, maxBuffer: settings.maxBytes + 1,
    });
    return output.stdout;
  });
  let bytes = 0;
  const read = async (args: readonly string[], count = true) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new NativeReviewArtifactError("review_artifact_unavailable");
    let text: string;
    try { text = await runner(args, { env, timeoutMs: Math.min(5_000, remaining), maxBytes }); }
    catch (error) {
      if (error instanceof NativeReviewArtifactError) throw error;
      if (error && typeof error === "object" && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw new NativeReviewArtifactError("review_artifact_too_large");
      }
      throw new NativeReviewArtifactError("review_artifact_unavailable");
    }
    if (Buffer.byteLength(text) > maxBytes) throw new NativeReviewArtifactError("review_artifact_too_large");
    if (count) bytes += Buffer.byteLength(text);
    if (bytes > maxBytes) throw new NativeReviewArtifactError("review_artifact_too_large");
    return text;
  };
  const metadata = async () => {
    try {
      const parsed = Metadata.parse(JSON.parse(await read(["pr", "view", target.prUrl, "--json", "url,state,headRefOid,baseRefOid,changedFiles,files"], false)));
      if (parsed.url.replace(/\/$/, "") !== target.prUrl.replace(/\/$/, "") || parsed.headRefOid !== target.headSha) {
        throw new NativeReviewArtifactError("review_artifact_head_changed");
      }
      if (parsed.changedFiles !== parsed.files.length || parsed.files.length > 100) throw new NativeReviewArtifactError("review_artifact_unavailable");
      return parsed;
    } catch (error) {
      if (error instanceof NativeReviewArtifactError) throw error;
      throw new NativeReviewArtifactError("review_artifact_unavailable");
    }
  };
  const before = await metadata();
  const paths = before.files.map(file => typeof file === "string" ? { path: file, changeType: undefined } : file);
  if (new Set(paths.map(file => file.path)).size !== paths.length || paths.some(file =>
    !file.path || file.path.startsWith("/") || /[\\\x00-\x1f]/.test(file.path) || file.path.split("/").some(part => part === ".." || part === "." || part === ""))) {
    throw new NativeReviewArtifactError("review_artifact_unavailable");
  }
  const comparisonPath = `repos/${url[1]}/${url[2]}/compare/${before.baseRefOid}...${target.headSha}`;
  let comparison: z.infer<typeof Comparison>;
  try {
    comparison = Comparison.parse(JSON.parse(await read(["api", comparisonPath, "--method", "GET", "--jq", COMPARISON_FIELDS], false)));
  } catch (error) {
    if (error instanceof NativeReviewArtifactError) throw error;
    throw new NativeReviewArtifactError("review_artifact_unavailable");
  }
  if (comparison.baseSha !== before.baseRefOid || comparison.files.length !== paths.length ||
      JSON.stringify(comparison.files.map(file => file.path).sort()) !== JSON.stringify(paths.map(file => file.path).sort())) {
    throw new NativeReviewArtifactError("review_artifact_unavailable");
  }
  // Both diff endpoints name immutable commits; a PR-number ABA race cannot
  // mix another head's patch with the SHA-pinned source contents.
  const diff = await read(["api", comparisonPath, "--method", "GET", "--header", "Accept: application/vnd.github.diff"]);
  if (/^Binary files |^GIT binary patch/m.test(diff)) throw new NativeReviewArtifactError("review_artifact_unavailable");
  const files: { path: string; headContent: string | null }[] = [];
  // Bound subprocess concurrency as well as aggregate output and wall time.
  for (let offset = 0; offset < comparison.files.length; offset += 4) {
    files.push(...await Promise.all(comparison.files.slice(offset, offset + 4).map(async file => {
      if (file.status === "removed") return { path: file.path, headContent: null };
      const encoded = file.path.split("/").map(encodeURIComponent).join("/");
      const raw = await read(["api", `repos/${url[1]}/${url[2]}/contents/${encoded}?ref=${target.headSha}`, "--method", "GET"], false);
      try {
        const blob = z.object({ type: z.literal("file"), encoding: z.literal("base64"), content: z.string(), size: z.number().int().nonnegative() }).parse(JSON.parse(raw));
        const buffer = Buffer.from(blob.content.replace(/\s/g, ""), "base64");
        if (buffer.length !== blob.size) throw new NativeReviewArtifactError("review_artifact_unavailable");
        bytes += buffer.length;
        if (bytes > maxBytes) throw new NativeReviewArtifactError("review_artifact_too_large");
        return { path: file.path, headContent: new TextDecoder("utf-8", { fatal: true }).decode(buffer) };
      } catch (error) {
        if (error instanceof NativeReviewArtifactError) throw error;
        throw new NativeReviewArtifactError("review_artifact_unavailable");
      }
    })));
  }
  const after = await metadata();
  if (after.baseRefOid !== before.baseRefOid || JSON.stringify(after.files.map(file => typeof file === "string" ? file : file.path).sort()) !==
      JSON.stringify(paths.map(file => file.path).sort())) {
    throw new NativeReviewArtifactError("review_artifact_head_changed");
  }
  const artifact: NativePullRequestArtifact = { complete: true, headSha: target.headSha, baseSha: comparison.mergeBaseSha, diff, files };
  if (Buffer.byteLength(JSON.stringify(artifact)) > maxBytes) throw new NativeReviewArtifactError("review_artifact_too_large");
  return artifact;
}
