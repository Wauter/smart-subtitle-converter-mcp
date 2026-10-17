import { z } from "zod";
import nodePath from "node:path";
import fsp from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { Call, Deps } from "../context.js";
import { mcpError, ToolFailure, type WarningT } from "../errors.js";
import { sanitizeOutputName, type WriteResult } from "../fs/write.js";
import { toInt } from "../api/coerce.js";
import {
  checkDestructive, DetectedOutput, defineTool, ebuSizeWarning, exactlyOne, getCaps, loadProfile, loadSource, mapDetected, mapWarnings,
  mapVerification, mutuallyExclusive, requirePathsAllowed, tooLarge, Verification, verificationText, Warning, warningText, withPartial,
  type SourceInput, type VerificationT,
} from "./common.js";

const IF_EXISTS = z.enum(["error", "replace", "archive", "delete"]);

export const ConvertOutput = {
  outputs: z.array(
    z.object({
      fileName: z.string(), format: z.string(), formatId: z.string(),
      kind: z.enum(["text", "binary"]).optional(),
      mediaType: z.string(), encoding: z.string(),
      contentEncoding: z.enum(["text", "base64"]),
      cues: z.number().int(), bytes: z.number().int(),
      writtenTo: z.string().optional(),
      action: z.enum(["written", "replaced", "archived", "deleted"]).optional(),
      archivedTo: z.string().optional(),
      inline: z.enum(["text", "resource"]).optional(),
      resourceUri: z.string().optional(),
      verification: Verification.optional(),
    }),
  ),
  detected: DetectedOutput.nullish(),
  stats: z.object({ paragraphsIn: z.number(), paragraphsOut: z.number(), elapsedMs: z.number().optional(), queueWaitMs: z.number().optional() }),
  warnings: z.array(Warning),
  profile: z.record(z.unknown()).optional(),
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
  text?: string;
  verification?: VerificationT;
}

export function describeConvert(deps: Deps): string {
  let d =
    "Convert one subtitle file to another format, optionally applying a preset's or profile's clean-up operations (timing offset, frame-rate change, line splitting, …).";
  if (deps.pathsInSchema) {
    d +=
      " Give the source as `path` (preferred: nothing passes through your context, and binary formats stay byte-exact) or as inline `content`; exactly one of them.";
  } else d += " Give the source as inline `content` (base64 for binary formats).";
  d +=
    " Choose the result with `target` (a format id or alias from list_formats), a `preset` (from list_presets), and/or a `profile` (custom JSON, checked first with validate_profile); at least one is required. `profile` values are merged over the preset.";
  if (deps.pathsInSchema) {
    d +=
      " With `outputPath` (exact file) or `outputDir` (the converter picks the name), the result is written to disk and only a summary comes back. Without them the converted subtitle is returned inline. Binary targets (EBU STL, PAC, …) are always returned as base64, so write them to disk. Output file names come from the converter; pass `fileName` for inline content so the output is named after it. If a file with that name already exists, the default `ifExists: \"error\"` fails and names the existing file (with an explicit `outputPath` this happens before converting), so ask the user whether to `replace`, `archive` (keep the old file as a `.bak`) or `delete` it, or pick another folder. Nothing half-written is ever left under the final name." +
      (deps.cfg.allowDestructive ? " `delete` removes the old file permanently; it can't be restored." : " `replace` and `delete` are disabled on this server unless the operator allows them; `archive` always works.");
  } else d += " The converted subtitle is returned inline (binary targets as base64).";
  d +=
    " Note: EBU Tech 3264 has no 29.97 fps code, so a 29.97 fps EBU STL source is written with the STL30.01 code; the API flags such frame-rate code mismatches with the warning `frame-rate-changed`. Timings change by less than one frame (no cumulative drift); tell the user, and see the warning for the workaround. Always report `warnings` to the user: they flag lossy formats, replaced characters, truncated text, zero-length cues, frame quantisation and frame-rate changes; many carry a `hint` with the setting that fixes them (the API never switches code pages or character tables by itself) and `details` with cue numbers and code points." +
    " Binary outputs carry `verification`: the file is read back and compared with what was written (verdict lossless | quantised (times rounded to frames only) | lossy | unverified, with cue counts, timing shift and replaced characters by cue number). A clean round trip proves the file is self-consistent through the converter's own reader, not that a given playout system accepts it." +
    " If a file matches both PAC and Unicode PAC (FPC) and its name doesn't decide, the API fails with `ambiguous-format`; pass `profile.source.format` ('pac' or 'fpc'). On `conversion-timeout`, split the file and convert the parts.";
  if (deps.pathsInSchema) d += ` ${deps.rootsText}`;
  return d;
}

export function registerConvertTool(server: McpServer, deps: Deps): void {
  const paths = deps.pathsInSchema;
  const shape = {
    content: z.string().optional().describe("Subtitle content: text, or base64 if contentEncoding is 'base64'"),
    contentEncoding: z.enum(["text", "base64"]).default("text"),
    ...(paths ? { path: z.string().optional().describe("Absolute path to the source file in an allowed folder") } : {}),
    fileName: z.string().max(255).optional().describe("Source file name; used for detection and to name the output"),
    preset: z.string().max(200).optional().describe("Preset name from list_presets"),
    target: z.string().max(100).optional().describe("Target format id or alias, e.g. 'webvtt', 'ebustl'"),
    profile: z.record(z.unknown()).optional().describe("Profile JSON or overrides on top of preset"),
    ...(paths
      ? {
          profilePath: z.string().optional().describe("Absolute path to a profile .json file (instead of `profile`)"),
          outputPath: z.string().optional().describe("Absolute path of the output file (single output only)"),
          outputDir: z.string().optional().describe("Absolute folder; files are named by the converter"),
          ifExists: IF_EXISTS.default("error").describe("If an output file already exists: error (default) | replace | archive (rename old to .bak) | delete"),
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
    annotations: paths && deps.writable
      ? { readOnlyHint: false, destructiveHint: deps.cfg.allowDestructive, idempotentHint: false }
      : { readOnlyHint: true, idempotentHint: true },
    handler: (a: any, call) => convertSubtitle(deps, a, call),
  });
}

export async function convertSubtitle(deps: Deps, a: any, call: Call) {
  requirePathsAllowed(deps, a, ["path", "profilePath", "outputPath", "outputDir"]);
  exactlyOne(a, deps.pathsInSchema ? ["content", "path"] : ["content"], "the subtitle source");
  if (a.preset === undefined && a.target === undefined && a.profile === undefined && a.profilePath === undefined)
    throw mcpError("invalid-arguments", "Say what to produce: give at least one of `preset`, `target`, `profile` or `profilePath`.", "Use list_formats for target ids or list_presets for presets.");
  mutuallyExclusive(a, "profile", "profilePath");
  mutuallyExclusive(a, "outputPath", "outputDir");
  const ifExists = a.ifExists ?? "error";
  checkDestructive(deps, ifExists);
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
      if (st) throw mcpError("output-exists", `Output already exists: ${a.outputPath}`, "Ask the user whether to replace, archive or delete this file, or choose another output path.", { path: a.outputPath });
    }
  }

  const caps = await getCaps(deps, call);
  const src = await loadSource(deps, a, caps);
  call.log.source = src.callerPath ? "path" : "inline";
  if (src.ext) call.log.inputExt = src.ext;
  call.log.inputHash = deps.log.p(src.callerPath ?? src.fileName ?? "inline");
  const profile = await loadProfile(deps, a, caps);
  const warnings: WarningT[] = ebuSizeWarning(src, caps);

  let result: { outputs: ApiOutput[]; detected: any; stats: any; warnings: WarningT[]; profile?: any; requestId?: string };
  {
    const body: Record<string, unknown> = { content: src.content, contentEncoding: src.contentEncoding };
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
    try {
      res = await deps.api.request({ method: "POST", path: "/v1/convert/json", kind: "conversion", raw: { body: json, contentType: "application/json" } }, call);
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
    };
  }
  warnings.unshift(...result.warnings);

  if (outFile && result.outputs.length > 1) {
    throw mcpError("multiple-outputs", `The conversion produced ${result.outputs.length} outputs (${result.outputs.map((o) => o.fileName).join(", ")}); outputPath takes exactly one. Nothing was written.`, "Use outputDir instead of outputPath.", { requestId: result.requestId });
  }

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
      outputs.push({ ...meta(o), writtenTo: w.path, action: w.action, ...(w.archivedTo ? { archivedTo: w.archivedTo } : {}) });
      blocks.push({ type: "resource_link", uri: pathToFileURL(w.path).toString(), name: nodePath.basename(w.path), mimeType: o.mediaType } as ContentBlock);
    }
  } else {
    for (const o of result.outputs) {
      const m: any = meta(o);
      if (o.contentEncoding === "text" && o.text !== undefined && o.data.length <= deps.cfg.inlineTextMaxBytes) {
        m.inline = "text";
        blocks.push({ type: "text", text: o.text });
      } else {
        const uri = `subtitleedit://outputs/${encodeURIComponent(result.requestId ?? call.requestId)}/${encodeURIComponent(o.fileName)}`;
        m.inline = "resource";
        m.resourceUri = uri;
        blocks.push({
          type: "resource",
          resource: o.contentEncoding === "text" && o.text !== undefined ? { uri, mimeType: o.mediaType, text: o.text } : { uri, mimeType: o.mediaType, blob: o.data.toString("base64") },
        } as ContentBlock);
      }
      outputs.push(m);
    }
  }

  const structured: any = {
    outputs,
    detected: result.detected,
    stats: Object.fromEntries(Object.entries(result.stats).filter(([, v]) => v !== undefined)),
    warnings,
    ...(a.includeEffectiveProfile && result.profile ? { profile: result.profile } : {}),
    ...(result.requestId ? { requestId: result.requestId } : {}),
    attempts: call.stats.attempts,
  };
  call.log.actions = countActions(written);
  return { structured, summary: convertSummary(src, result, outputs, warnings, deps, toDisk), blocks };
}

function meta(o: ApiOutput) {
  return {
    fileName: o.fileName, format: o.format, formatId: o.formatId, ...(o.kind ? { kind: o.kind } : {}), mediaType: o.mediaType, encoding: o.encoding,
    contentEncoding: o.contentEncoding, cues: o.cues, bytes: o.data.length, ...(o.verification ? { verification: o.verification } : {}),
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
    contentEncoding: enc, cues: toInt(o?.cues), data, ...(enc === "text" ? { text: content } : {}),
    ...(mapVerification(o?.verification) ? { verification: mapVerification(o?.verification) } : {}),
  };
}

export function countActions(ws: { action: string }[]) {
  const c = { written: 0, replaced: 0, archived: 0, deleted: 0 };
  for (const w of ws) (c as any)[w.action]++;
  return c;
}

function convertSummary(src: SourceInput, r: any, outputs: any[], warnings: WarningT[], deps: Deps, toDisk: boolean): string {
  const d = r.detected;
  const from = `${src.fileName ?? "content"}${d ? ` (${d.format}, ${d.encoding}${d.language ? `, ${d.language}` : ""})` : ""}`;
  const to = outputs.map((o) => `${o.fileName} (${o.format}, ${o.encoding})`).join(", ");
  let s = `Converted ${from} → ${to}: ${r.stats.paragraphsIn} → ${r.stats.paragraphsOut} cues${r.stats.elapsedMs !== undefined ? ` in ${r.stats.elapsedMs} ms` : ""}.`;
  for (const o of outputs) {
    if (!o.writtenTo) continue;
    if (o.action === "archived") s += ` Wrote ${o.writtenTo} (archived the old file to ${nodePath.basename(o.archivedTo)}).`;
    else if (o.action === "replaced") s += ` Replaced ${o.writtenTo}.`;
    else if (o.action === "deleted") s += ` Wrote ${o.writtenTo} (deleted the old file).`;
    else s += ` Wrote ${o.writtenTo}.`;
  }
  if (!toDisk && outputs.some((o) => o.inline === "resource")) s += deps.pathsInSchema ? " The result is attached as an embedded resource; use outputPath/outputDir to write it to disk instead." : " The result is attached as an embedded resource.";
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
