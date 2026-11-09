import { z } from "zod";
import nodePath from "node:path";
import fsp from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { Call, Deps } from "../context.js";
import { mcpError, ToolFailure, type WarningT } from "../errors.js";
import { sanitizeOutputName, type WriteResult } from "../fs/write.js";
import { finishConversion } from "../api/jobs.js";
import { toInt } from "../api/coerce.js";
import { locationBaseName } from "./textPage.js";
import {
  apiStorageDescription, DetectedOutput, defineTool, ebuSizeWarning, exactlyOne, getCaps, loadProfile, loadSource, mapDetected, mapWarnings,
  mapVerification, mutuallyExclusive, requirePathsAllowed, refreshToolDescriptions, tooLarge, Verification, verificationText, Warning, warningText, withPartial,
  type SourceInput, type VerificationT,
} from "./common.js";

const IF_EXISTS = z.enum(["error", "replace"]);

export const ConvertOutput = {
  jobId: z.string().optional(),
  outputs: z.array(
    z.object({
      fileName: z.string(), format: z.string(), formatId: z.string(),
      kind: z.enum(["text", "binary"]).optional(),
      mediaType: z.string(), encoding: z.string(),
      contentEncoding: z.enum(["text", "base64"]),
      cues: z.number().int(), bytes: z.number().int(),
      writtenTo: z.string().optional(),
      output: z.string().optional(),
      action: z.enum(["written", "replaced"]).optional(),
      attached: z.boolean().optional().describe("true when the whole converted file is attached to this result as an embedded resource (no output location given)"),
      verification: Verification.optional(),
    }),
  ),
  detected: DetectedOutput.nullish(),
  stats: z.object({ paragraphsIn: z.number(), paragraphsOut: z.number(), elapsedMs: z.number().optional(), queueWaitMs: z.number().optional() }),
  warnings: z.array(Warning),
  profile: z.record(z.string(), z.unknown()).optional(),
  hint: z.string().optional().describe("How to read the converted text: preview_text when the job has a stored file, otherwise how to get one"),
  requestId: z.string().optional(),
  attempts: z.number().int(),
};

interface ApiOutput {
  fileName: string;
  format: string;
  formatId: string;
  kind?: "text" | "binary";
  mediaType: string;
  encoding: string;
  contentEncoding: "text" | "base64";
  cues: number;
  data: Buffer;
  retained: boolean;
  byteCount: number;
  output?: string;
  text?: string;
  verification?: VerificationT;
}

export function describeConvert(deps: Deps): string {
  let d =
    "Convert one subtitle file to another format, optionally applying a preset's or profile's clean-up operations (timing offset, frame-rate change, line splitting, …).";
  if (deps.pathsInSchema) {
    d +=
      " Give the source as server-side `input` (file/S3/HTTPS, resolved by the API allowlists), `path` (preferred: nothing passes through your context, and binary formats stay byte-exact) or as inline `content`; exactly one source.";
  } else d += " Give the source as inline `content` (base64 for binary formats) or server-side `input` (file/S3/HTTPS URI).";
  d +=
    " Choose the result with `target` (a format id or alias from list_formats), a `preset` (from list_presets), and/or a `profile` (custom JSON, checked first with validate_profile); at least one is required. `profile` values are merged over the preset.";
  if (deps.pathsInSchema) {
    d += " With outputPath (exact file) or outputDir (API-generated basename), write a local result and return metadata. ifExists is error (default) | replace, for both local writes and API output. Explicit replace is sufficient. Choose another path if replacement is unwanted.";
  }
  d += ` Without ${deps.pathsInSchema ? "outputPath/outputDir or " : ""}an API \`output\`, the whole converted file is attached as an embedded resource (text formats as text, binary formats as base64) for the client to save; it is the deliverable, not a view for you, and \`outputs[].attached\` is true. Its text is not repeated in the structured result. Inline results are not stored, so preview_text cannot read them: save the attached file and read it locally, or convert with an API \`output\` and call preview_text {jobId, which:"output"}; \`hint\` says what applies.`;
  d += " Server-side `output` stores the result via the API instead of returning bytes; `sidecar:true` requests output.json. It cannot be combined with local outputPath/outputDir. Jobs expose jobId and the MCP polls 202 responses. Cancelling this call does not cancel accepted API work. Filesystem and S3 reject an existing output by default; ifExists:replace allows replacement. Presigned HTTPS PUT follows whatever the signer/receiver allowed, not a filesystem/S3 lock. API locations are not governed by list_allowed_folders.";
  d +=
    " Note: EBU Tech 3264 has no 29.97 fps code, so a 29.97 fps EBU STL source is written with the STL30.01 code; the API flags such frame-rate code mismatches with the warning `frame-rate-changed`. Timings change by less than one frame (no cumulative drift); tell the user, and see the warning for the workaround. Always report `warnings` to the user: they flag lossy formats, replaced characters, truncated text, zero-length cues, frame quantisation and frame-rate changes; many carry a `hint` with the setting that fixes them (the API never switches code pages or character tables by itself) and `details` with cue numbers and code points. For `characters-replaced`, `details.remedy` lists the setting (`option`), its `allowedValues`, the value in effect and the `candidates` that keep the characters (for PAC tested by the converter); `suggested` is set only when exactly one fits. With several candidates, choose by the text's language (ask the user if unsure), or use `unicodeAlternative` (fpc)." +
    " Binary outputs carry `verification`: the file is read back and compared with what was written (verdict lossless | quantised (times rounded to frames only) | lossy | unverified, with cue counts, timing shift and replaced characters by cue number). A clean round trip proves the file is self-consistent through the converter's own reader, not that a given playout system accepts it." +
    " If a file matches both PAC and Unicode PAC (FPC) and its name doesn't decide, the API fails with `ambiguous-format`; pass `profile.source.format` ('pac' or 'fpc'). If it can't tell the character set from the words, it fails with `ambiguous-encoding`; show the candidate samples, pick only from that list, tell the user, then retry with `profile.formatOptions.pac.inputCodePage`, `profile.encoding.input` or `profile.encoding.language` as `error.probe` says. On `conversion-timeout`, split the file and convert the parts.";
  d += apiStorageDescription(deps);
  d += " One file per call; loop for folders, never zip them. If work may outlive the wait, pass output; response-only bytes may never be available after 202. Use preview_text after a conversion with API `input`/`output` to read the stored file's text (paged).";
  if (deps.pathsInSchema) d += ` ${deps.rootsText}`;
  return d;
}

export function registerConvertTool(server: McpServer, deps: Deps): void {
  const paths = deps.pathsInSchema;
  const shape = {
    input: z.string().max(16384).optional().describe("Server-side input URI (file, s3 or https); mutually exclusive with content/path"),
    output: z.string().max(16384).optional().describe("Exact server-side destination URI; mutually exclusive with local outputPath/outputDir"),
    ifExists: IF_EXISTS.default("error").describe("error (default) | replace; applies to local and API outputs; HTTPS follows signer/receiver policy"),
    sidecar: z.boolean().default(false).describe("Write output.json beside a server-side output; HTTPS output skips it with a warning"),
    content: z.string().optional().describe("Subtitle content: text, or base64 if contentEncoding is 'base64'"),
    contentEncoding: z.enum(["text", "base64"]).default("text"),
    ...(paths ? { path: z.string().optional().describe("Absolute path to the source file in an allowed folder") } : {}),
    fileName: z.string().max(255).optional().describe("Source file name; used for detection and to name the output"),
    preset: z.string().max(200).optional().describe("Preset name from list_presets"),
    target: z.string().max(100).optional().describe("Target format id or alias, e.g. 'webvtt', 'ebustl'"),
    profile: z.record(z.string(), z.unknown()).optional().describe("Profile JSON or overrides on top of preset"),
    ...(paths
      ? {
          profilePath: z.string().optional().describe("Absolute path to a profile .json file (instead of `profile`)"),
          outputPath: z.string().optional().describe("Absolute path of the output file (single output only)"),
          outputDir: z.string().optional().describe("Absolute folder; files are named by the converter"),
        }
      : {}),
    responseEncoding: z.enum(["text", "base64"]).optional().describe("Inline results only: force base64 for text targets"),
    includeEffectiveProfile: z.boolean().default(false).describe("Return the merged profile the API applied"),
  };

  defineTool(server, deps, {
    name: "convert_subtitle",
    warningArray: true,
    title: "Convert subtitle",
    description: () => describeConvert(deps),
    shape,
    output: ConvertOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async (a: any, call) => { try { return await convertSubtitle(deps, a, call); } finally { refreshToolDescriptions(server); } },
  });
}

export async function convertSubtitle(deps: Deps, a: any, call: Call) {
  requirePathsAllowed(deps, a, ["path", "profilePath", "outputPath", "outputDir"]);
  exactlyOne(a, deps.pathsInSchema ? ["content", "path", "input"] : ["content", "input"], "the subtitle source");
  if (a.preset === undefined && a.target === undefined && a.profile === undefined && a.profilePath === undefined)
    throw mcpError("invalid-arguments", "Say what to produce: give at least one of `preset`, `target`, `profile` or `profilePath`.", "Use list_formats for target ids or list_presets for presets.");
  mutuallyExclusive(a, "profile", "profilePath");
  mutuallyExclusive(a, "outputPath", "outputDir");
  mutuallyExclusive(a, "output", "outputPath"); mutuallyExclusive(a, "output", "outputDir");
  const ifExists = a.ifExists ?? "error";
  const toDisk = a.outputPath !== undefined || a.outputDir !== undefined;

  // Output location checks (no directories created yet).
  let outFile: { dir: string; name: string; full: string } | undefined;
  if (a.outputPath !== undefined) outFile = await deps.guard.resolveOutputFile(a.outputPath, false);
  if (a.outputDir !== undefined) await deps.guard.resolveOutputDir(a.outputDir, false);

  // Explicit outputPath: source check and the only pre-check (D-32).
  let srcReal: string | undefined;
  if (a.path !== undefined) srcReal = (await deps.guard.resolveInputFile(a.path)).real;
  if (outFile) {
    if (srcReal && (outFile.full === srcReal || (await fsp.realpath(outFile.full).catch(() => "")) === srcReal))
      throw mcpError("source-overwrite-refused", `Refusing to write over the source file: ${a.outputPath}`, "Choose another output path.", { path: a.outputPath });
    if (ifExists === "error") {
      const st = await fsp.lstat(outFile.full).catch(() => null);
      if (st) throw mcpError("output-exists", `Output already exists: ${a.outputPath}`, "Valid ifExists values: error | replace. Choose another path or explicitly replace; a previous job may have written or still be writing this location.", { path: a.outputPath });
    }
  }

  const caps = await getCaps(deps, call);
  const src = await loadSource(deps, a, caps);
  call.log.source = src.callerPath ? "path" : "inline";
  if (src.ext) call.log.inputExt = src.ext;
  call.log.inputHash = deps.log.p(src.callerPath ?? src.fileName ?? "inline");
  const profile = await loadProfile(deps, a, caps);
  const warnings: WarningT[] = ebuSizeWarning(src, caps);

  let result: { outputs: ApiOutput[]; detected: any; stats: any; warnings: WarningT[]; profile?: any; requestId?: string; jobId?: string };
  {
    const body: Record<string, unknown> = src.input !== undefined ? { input: src.input } : { content: src.content, contentEncoding: src.contentEncoding };
    if (a.output !== undefined) { body.output = a.output; body.ifExists = ifExists; }
    if (a.sidecar && a.output !== undefined) body.sidecar = true;
    if (src.fileName) body.fileName = src.fileName;
    if (a.preset !== undefined) body.preset = a.preset;
    if (a.target !== undefined) body.target = a.target;
    if (profile !== undefined) body.profile = profile;
    const respEnc = toDisk ? "base64" : a.responseEncoding;
    if (respEnc) body.responseEncoding = respEnc;
    const json = JSON.stringify(body);
    const n = Buffer.byteLength(json);
    if (n > caps.jsonBody) throw tooLarge("The request body", { name: "maxRequestBodyBytes.json", value: caps.jsonBody }, n);
    let res;
    const started = Date.now();
    try {
      res = await deps.api.request({ method: "POST", path: "/v1/convert/json", kind: "conversion", headers: { Prefer: `wait=${Math.max(0, Math.min(caps.requestMaxWaitSeconds ?? 60, Math.floor(deps.cfg.timeoutMs / 1000)))}` }, raw: { body: json, contentType: "application/json" } }, call);
      res = await finishConversion(deps.api, res, call, deps.cfg, started);
    } catch (e) {
      if (e instanceof ToolFailure && e.toolError.status === 413) deps.limits.invalidate();
      throw e;
    }
    const r: any = res.json ?? {};
    if (!Array.isArray(r.outputs)) throw mcpError("api-protocol-error", "The convert response has no outputs.", "Report this with the requestId.", { requestId: res.requestId });
    result = {
      outputs: r.outputs.map(parseApiOutput),
      detected: mapDetected(r.detected),
      stats: { paragraphsIn: toInt(r.stats?.paragraphsIn), paragraphsOut: toInt(r.stats?.paragraphsOut), elapsedMs: toInt(r.stats?.elapsedMs), queueWaitMs: toInt(r.stats?.queueWaitMs) },
      warnings: mapWarnings(r.warnings),
      profile: r.profile,
      requestId: res.requestId,
      jobId: typeof r.id === "string" ? r.id : res.headers.get("x-job-id") ?? undefined,
    };
  }
  warnings.unshift(...result.warnings);

  if (outFile && result.outputs.length > 1) {
    throw mcpError("multiple-outputs", `The conversion produced ${result.outputs.length} outputs (${result.outputs.map((o) => o.fileName).join(", ")}); outputPath takes exactly one. Nothing was written.`, "Use outputDir instead of outputPath.", { requestId: result.requestId });
  }

  if (!a.output && result.outputs.some((o) => !o.retained))
    throw mcpError("job-output-not-stored", "The asynchronous response-only conversion retained no file bytes or stored output.", "Inspect the original result. Pass output for work that can outlive the wait; do not blindly resubmit writes.", { jobId: result.jobId });
  const outputs: any[] = [];
  const blocks: ContentBlock[] = [];
  const written: WriteResult[] = [];
  if (toDisk) {
    const dir = outFile ? await deps.guard.resolveOutputDir(nodePath.dirname(a.outputPath), true, a.outputPath) : await deps.guard.resolveOutputDir(a.outputDir, true);
    const sources = new Set(srcReal ? [srcReal] : []);
    for (const o of result.outputs) {
      const name = outFile ? outFile.name : sanitizeOutputName(o.fileName);
      let w: WriteResult;
      try {
        w = await deps.writer.write({ dir, name, data: o.data, ifExists, sources, signal: call.signal });
      } catch (e) {
        if (e instanceof ToolFailure) {
          if (!e.toolError.requestId && result.requestId) e.toolError.requestId = result.requestId;
          if (outputs.length) {
            throw withPartial(e, { outputs }, `Already written: ${outputs.map((x) => x.writtenTo).join(", ")}. Failed: ${nodePath.join(dir, name)}.`);
          }
        }
        throw e;
      }
      written.push(w);
      warnings.push(...w.warnings);
      outputs.push({ ...meta(o), writtenTo: w.path, action: w.action });
      blocks.push({ type: "resource_link", uri: pathToFileURL(w.path).toString(), name: nodePath.basename(w.path), mimeType: o.mediaType } as ContentBlock);
    }
  } else {
    for (const o of result.outputs) {
      const m: any = meta(o);
      if (!o.retained) {
        outputs.push(m);
        continue;
      }
      // The whole file as an embedded resource the client may save: text formats as text, binary as base64.
      // Its uri only labels the block (spec-required); it is not readable with resources/read.
      const uri = `subtitleedit://outputs/${encodeURIComponent(result.requestId ?? call.requestId)}/${encodeURIComponent(o.fileName)}`;
      blocks.push({
        type: "resource",
        resource: o.contentEncoding === "text" && o.text !== undefined ? { uri, mimeType: o.mediaType, text: o.text } : { uri, mimeType: o.mediaType, blob: o.data.toString("base64") },
      } as ContentBlock);
      m.attached = true;
      outputs.push(m);
    }
  }

  const hint = readHint(result.jobId, outputs, src);
  const structured: any = {
    outputs,
    ...(result.jobId ? { jobId: result.jobId } : {}),
    detected: result.detected,
    stats: Object.fromEntries(Object.entries(result.stats).filter(([, v]) => v !== undefined)),
    warnings,
    ...(a.includeEffectiveProfile && result.profile ? { profile: result.profile } : {}),
    ...(hint ? { hint } : {}),
    ...(result.requestId ? { requestId: result.requestId } : {}),
    attempts: call.stats.attempts,
  };
  call.log.actions = countActions(written);
  return { structured, summary: convertSummary(src, result, outputs, warnings, deps, toDisk), blocks };
}

/** Short, plain guidance on reading the converted text with preview_text; only what will actually work for this job. */
function readHint(jobId: string | undefined, outputs: any[], src: SourceInput): string | undefined {
  if (!jobId) return undefined;
  if (outputs.some((o) => o.output)) return `Read the converted text with preview_text {jobId:"${jobId}", which:"output"}.`;
  if (!outputs.some((o) => o.attached)) return undefined;
  // Inline outputs are not stored anywhere, so preview_text cannot read them: the attached file is the only copy.
  let h = "The whole file is in the attached embedded resource; save it to disk and read it locally if you need the text. To preview it with preview_text instead, convert with an API `output` location.";
  if (src.input !== undefined) h += ` The source can be previewed now with preview_text {jobId:"${jobId}", which:"input"}.`;
  return h;
}

function meta(o: ApiOutput) {
  // A stored output's real name is the last segment of its location, not the converter's generated name.
  const stored = o.output ? locationBaseName(o.output) : undefined;
  return {
    fileName: stored || o.fileName, format: o.format, formatId: o.formatId, ...(o.kind ? { kind: o.kind } : {}), mediaType: o.mediaType, encoding: o.encoding,
    contentEncoding: o.contentEncoding, cues: o.cues, bytes: o.byteCount, ...(o.output ? { output: o.output } : {}), ...(o.verification ? { verification: o.verification } : {}),
  };
}

export function parseApiOutput(o: any): ApiOutput {
  const enc = o?.contentEncoding === "base64" ? "base64" : "text";
  const content = typeof o?.content === "string" ? o.content : "";
  const data = enc === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
  return {
    fileName: String(o?.fileName ?? ""), format: String(o?.format ?? ""), formatId: String(o?.formatId ?? ""),
    ...(o?.kind === "text" || o?.kind === "binary" ? { kind: o.kind } : {}),
    mediaType: String(o?.mediaType ?? "application/octet-stream"), encoding: String(o?.encoding ?? ""),
    contentEncoding: enc, cues: toInt(o?.cues), data, retained: typeof o?.content === "string", byteCount: toInt(o?.bytes, data.length), ...(typeof o?.output === "string" ? { output: o.output } : {}), ...(enc === "text" ? { text: content } : {}),
    ...(mapVerification(o?.verification) ? { verification: mapVerification(o?.verification) } : {}),
  };
}

export function countActions(ws: { action: string }[]) {
  const c = { written: 0, replaced: 0 };
  for (const w of ws) (c as any)[w.action]++;
  return c;
}

function convertSummary(src: SourceInput, r: any, outputs: any[], warnings: WarningT[], deps: Deps, toDisk: boolean): string {
  const d = r.detected;
  const from = `${src.fileName ?? "content"}${d ? ` (${d.format}, ${d.encoding}${d.language ? `, ${d.language}` : ""})` : ""}`;
  const to = outputs.map((o) => `${o.fileName} (${o.format}, ${o.encoding})`).join(", ");
  let s = `Converted ${from} → ${to}: ${r.stats.paragraphsIn} → ${r.stats.paragraphsOut} cues${r.stats.elapsedMs !== undefined ? ` in ${r.stats.elapsedMs} ms` : ""}.`;
  for (const o of outputs) {
    if (o.output) s += ` Stored at ${o.output}.`;
    if (!o.writtenTo) continue;
    if (o.action === "replaced") s += ` Replaced ${o.writtenTo}.`;
    else s += ` Wrote ${o.writtenTo}.`;
  }
  if (!toDisk && outputs.some((o) => o.attached)) s += deps.pathsInSchema ? " The whole converted file is attached as an embedded resource; use outputPath/outputDir to write it to disk instead." : " The whole converted file is attached as an embedded resource.";
  for (const o of outputs) if (o.verification) s += ` Verification of ${o.fileName}: ${verificationText(o.verification)}.`;
  if (warnings.length) s += ` ${warnings.length} warning${warnings.length === 1 ? "" : "s"}: ${warnings.map(warningText).join("; ")}`;
  // §5.6.5: frame-rate-changed goes on its own line right after the first line, before everything else.
  const frc = warnings.filter((w) => w.code === "frame-rate-changed");
  if (frc.length) {
    const nl = s.indexOf("\n");
    const line = frc.map((w) => `Frame rate changed: ${w.message}`).join("\n");
    s = nl === -1 ? `${s}\n${line}` : `${s.slice(0, nl)}\n${line}${s.slice(nl)}`;
  }
  return s;
}
