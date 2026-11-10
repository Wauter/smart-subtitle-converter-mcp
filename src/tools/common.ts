import { z, type ZodTypeAny } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ContentBlock, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { errorText, FieldError, mcpError, ToolFailure, ToolErrorSchema, Warning, type ToolError, type WarningT } from "../errors.js";
import { newCallId, withSuffix } from "../ids.js";
import { newStats, type CallCtx } from "../api/client.js";
import { capsFrom, type Caps } from "../api/limits.js";
import { toInt } from "../api/coerce.js";
import type { Call, Deps } from "../context.js";
import { isValidBase64, decodedBase64Length } from "../base64.js";
import { readFileChecked } from "../fs/guard.js";
import { mcpErrorFromZod } from "./zodError.js";
import { apiInfo, mismatchWarning } from "../api/info.js";
import { extensionCheckSkippedWarning } from "../fs/extensions.js";
import { probeApi } from "../probe.js";

export { FieldError, Warning };

export interface ToolOutcome {
  structured: Record<string, unknown>;
  summary: string;
  blocks?: ContentBlock[];
  logFields?: Record<string, unknown>;
}

export interface ToolDef<S extends Record<string, z.ZodType>> {
  name: string;
  title: string;
  /** A function when the text depends on the allowed folders: it's rebuilt after a client-roots change. */
  description: string | (() => string);
  shape: S;
  output: Record<string, z.ZodType>;
  annotations: ToolAnnotations;
  /** structured.warnings is a Warning[] ({code,message}); the version-mismatch warning may be added there. */
  warningArray?: boolean;
  handler: (args: z.infer<z.ZodObject<S>>, call: Call) => Promise<ToolOutcome>;
}

/** API schemes, deliberately separate from MCP-local folder roots. */
export function apiStorageDescription(deps: Deps): string {
  const state = deps.limits.peek(), l = state?.kind === "ok" ? state.limits : undefined;
  if (!l?.inputSchemes || !l.outputSchemes) return "";
  const schemes = l.enabledSchemes ?? [];
  let text = ` API storage enabled: ${schemes.join(", ") || "none"}.`;
  if (l?.inputSchemes && l.outputSchemes && l.inputSchemes.join(",") !== l.outputSchemes.join(","))
    text += ` Input schemes: ${l.inputSchemes.join(", ") || "none"}; output schemes: ${l.outputSchemes.join(", ") || "none"}.`;
  return text;
}

/** Per server: tools whose description is rebuilt when allowed folders or cached API schemes change. */
const dynamicDescriptions = new WeakMap<McpServer, { tool: RegisteredTool; describe: () => string }[]>();

/**
 * Rebuilds the folder/API-dependent tool descriptions from the current roots. When any changed (and the server is
 * connected), sends one notifications/tools/list_changed so clients fetch tools/list again. Returns whether any changed.
 */
export function refreshToolDescriptions(server: McpServer, _deps?: Deps): boolean {
  let changed = false;
  for (const d of dynamicDescriptions.get(server) ?? []) {
    const text = d.describe();
    if (d.tool.description !== text) {
      d.tool.description = text;
      changed = true;
    }
  }
  if (changed) server.sendToolListChanged();
  return changed;
}

/** Registers a tool with strict input parsing (→ invalid-arguments), error mapping and one log record per call. */
export function defineTool<S extends Record<string, z.ZodType>>(server: McpServer, deps: Deps, def: ToolDef<S>): void {
  const strict = z.object(def.shape).strict();
  const describe = typeof def.description === "function" ? def.description : undefined;
  const registered = server.registerTool(
    def.name,
    {
      title: def.title,
      description: describe ? describe() : (def.description as string),
      inputSchema: strict as unknown as S,
      // The client SDK validates structured errors too, even when isError=true. Advertise
      // both shapes; success is still validated against the original required shape below.
      outputSchema: {
        ...Object.fromEntries(Object.entries(def.output).map(([key, value]) => [key, value.optional()])),
        error: ToolErrorSchema.optional(),
        warnings: errorWarnings(def.output.warnings),
      },
      annotations: { title: def.title, openWorldHint: false, ...def.annotations },
    },
    (async (rawArgs: unknown, extra: any): Promise<CallToolResult> => {
      const started = Date.now();
      const id = newCallId();
      const progressToken = extra?._meta?.progressToken;
      let progressN = 0;
      const call: Call = {
        tool: def.name,
        requestId: id,
        signal: extra?.signal,
        stats: newStats(),
        log: {},
        progress: async (message: string) => {
          if (progressToken === undefined || !extra?.sendNotification) return;
          progressN++;
          await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: progressN, message } });
        },
        onProgress: undefined,
      };
      call.onProgress = call.progress;
      let outcome: "ok" | "error" = "ok";
      let code: string | undefined;
      let apiStatus: number | undefined;
      try {
        const parsed = strict.safeParse(rawArgs ?? {});
        if (!parsed.success) throw mcpErrorFromZod(parsed.error, def.shape, rawArgs);
        const out = await def.handler(parsed.data as any, call);
        Object.assign(call.log, out.logFields ?? {});
        // §10 [DC]: the short version-mismatch warning rides on results while the mismatch persists; likewise the
        // skipped extension check (an older API without storage.extensions).
        for (const w of [mismatchWarning(), call.extensionCheckSkipped ? extensionCheckSkippedWarning(apiInfo.version) : undefined]) {
          if (!w) continue;
          if (def.warningArray) {
            if (!Array.isArray(out.structured.warnings)) out.structured.warnings = [];
            (out.structured.warnings as WarningT[]).push(w);
          }
          out.summary += `\nWarning ${w.code}: ${w.message}`;
        }
        z.object(def.output).passthrough().parse(out.structured);
        return {
          content: [{ type: "text", text: out.summary }, ...(out.blocks ?? [])],
          structuredContent: out.structured,
        };
      } catch (err) {
        outcome = "error";
        const tf = err instanceof ToolFailure ? err : internalFailure(err, deps);
        if (!tf.toolError.requestId && call.stats.requestIds.length) tf.toolError.requestId = call.stats.requestIds[call.stats.requestIds.length - 1];
        if (tf.toolError.attempts === undefined && call.stats.attempts) tf.toolError.attempts = call.stats.attempts;
        code = tf.toolError.code;
        apiStatus = tf.toolError.status;
        const structured: Record<string, unknown> = { error: tf.toolError, ...((tf as any).partial ?? {}) };
        for (const mm of [mismatchWarning(), call.extensionCheckSkipped ? extensionCheckSkippedWarning(apiInfo.version) : undefined])
          if (mm && !tf.warnings.some((w) => w.code === mm.code)) tf.warnings.push(mm);
        if (tf.warnings.length) structured.warnings = tf.warnings;
        let text = errorText(tf.toolError);
        if (tf.warnings.length) text += "\n" + tf.warnings.map((w) => `Warning ${w.code}: ${w.message}`).join("\n");
        if ((tf as any).partialText) text += "\n" + (tf as any).partialText;
        return { isError: true, content: [{ type: "text", text }], structuredContent: structured };
      } finally {
        deps.log.info("tool", {
          tool: def.name,
          mode: deps.cfg.mode,
          durationMs: Date.now() - started,
          outcome,
          ...(code ? { code } : {}),
          ...(apiStatus ? { apiStatus } : {}),
          requestIds: call.stats.requestIds,
          attempts: call.stats.attempts,
          retryWaitMs: call.stats.retryWaitMs,
          bytesIn: call.stats.bytesIn,
          bytesOut: call.stats.bytesOut,
          ...call.log,
        });
      }
    }) as any,
  );
  if (describe) {
    const list = dynamicDescriptions.get(server) ?? [];
    list.push({ tool: registered, describe });
    dynamicDescriptions.set(server, list);
  }
}

/**
 * Error results carry Warning[] in `warnings`. A success shape that already is Warning[] keeps its own schema (once,
 * not listed twice); a different success shape (e.g. profile FieldError[]) is unioned with Warning[].
 */
function errorWarnings(success: z.ZodType | undefined): z.ZodType {
  if (!success) return z.array(Warning).optional();
  const base: any = success instanceof z.ZodOptional ? success.unwrap() : success;
  if (base instanceof z.ZodArray && base.element === Warning) return success.optional();
  return z.union([success, z.array(Warning)]).optional();
}

function internalFailure(err: unknown, deps: Deps): ToolFailure {
  deps.log.error("internal error", { error: (err as Error)?.message, stack: deps.log.level === "debug" ? (err as Error)?.stack : undefined });
  return mcpError("internal-error", `Unexpected MCP error: ${(err as Error)?.message ?? String(err)}`, "This is an MCP bug; report it with the requestId.");
}

/** Attaches already-committed outputs to an error result (structured + text). */
export function withPartial(tf: ToolFailure, partial: Record<string, unknown>, text?: string): ToolFailure {
  (tf as any).partial = partial;
  if (text) (tf as any).partialText = text;
  return tf;
}

// ---------- shared argument helpers ----------

export function exactlyOne(args: Record<string, unknown>, keys: string[], what: string): string {
  const set = keys.filter((k) => args[k] !== undefined);
  if (set.length !== 1) throw mcpError("invalid-arguments", `Give exactly one of ${keys.map((k) => `\`${k}\``).join(" or ")} (${what}); got ${set.length ? set.join(", ") : "none"}.`);
  return set[0];
}

export function mutuallyExclusive(args: Record<string, unknown>, a: string, b: string): void {
  if (args[a] !== undefined && args[b] !== undefined) throw mcpError("invalid-arguments", `\`${a}\` and \`${b}\` are mutually exclusive.`);
}

export function requirePathsAllowed(deps: Deps, args: Record<string, unknown>, keys: string[]): void {
  if (deps.pathsInSchema) return;
  for (const k of keys) if (args[k] !== undefined) throw mcpError("invalid-arguments", `\`${k}\` is not available in this mode.`);
}

export async function getCaps(deps: Deps, call: Call): Promise<Caps> {
  // Retry the /healthz probe on the first tool call if startup couldn't reach the API (§10 step 3).
  if (!apiInfo.probedAt) await probeApi(deps.cfg, deps.log);
  // Own stats: `attempts` in results counts the main request only.
  const state = await deps.limits.get({ requestId: withSuffix(call.requestId, ".l"), signal: call.signal, stats: newStats() });
  return capsFrom(state, deps.cfg);
}

/** Smallest of the applicable caps for a single input sent through a JSON endpoint. */
export function inputCap(caps: Caps): { name: string; value: number } {
  let c = { name: "json.maxDecodedContentBytes", value: caps.jsonDecoded };
  if (caps.localMax !== undefined && caps.localMax < c.value) c = { name: "SUBTITLE_MCP_MAX_BYTES", value: caps.localMax };
  return c;
}

export function tooLarge(what: string, limit: { name: string; value: number }, actual: number, hint = "Split the file."): ToolFailure {
  return mcpError("precheck-too-large", `${what} is ${actual} bytes; the limit is ${limit.value} (${limit.name}).`, hint, { limit: { ...limit, actual } });
}

export interface SourceInput {
  input?: string;
  /** Value for the JSON body. */
  content: string;
  contentEncoding: "text" | "base64";
  fileName?: string;
  /** Decoded byte size. */
  size: number;
  real?: string;
  callerPath?: string;
  bytes?: Buffer;
  ext?: string;
}

/** API input scheme for logs: s3 | file | https (a bare absolute path is file). */
export function inputScheme(input: string): string {
  if (input.startsWith("/")) return "file";
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(input);
  return m ? m[1].toLowerCase() : "unknown";
}

/** An API input without credentials, query or fragment (presigned HTTPS signatures never reach logs or text). */
export function redactInput(input: string): string {
  if (input.startsWith("/")) return input;
  try { const u = new URL(input); u.username = ""; u.password = ""; u.search = ""; u.hash = ""; return u.href; } catch { return "[invalid uri]"; }
}

/** Last path segment of an API input, or undefined. */
function inputBaseName(input: string): string | undefined {
  const p = input.startsWith("/") ? input : (() => { try { return new URL(input).pathname; } catch { return ""; } })();
  const last = p.split("/").pop();
  if (!last) return undefined;
  try { return decodeURIComponent(last); } catch { return last; }
}

/** Log fields for the source: `source` is path | inline | s3 | file | https (the API input's scheme). */
export function logSource(deps: Deps, call: Call, src: SourceInput): void {
  call.log.source = src.input !== undefined ? inputScheme(src.input) : src.callerPath ? "path" : "inline";
  const name = src.input !== undefined ? inputBaseName(src.input) : src.fileName;
  const ext = src.ext ?? (name && /\.[^./]+$/.exec(name)?.[0].toLowerCase());
  if (ext) call.log.inputExt = ext;
  if (src.input !== undefined) call.log.inputHash = deps.log.p(redactInput(src.input));
  else if (src.callerPath) call.log.inputHash = deps.log.p(src.callerPath);
  else if (src.fileName) call.log.inputHash = deps.log.p(src.fileName);
}

/** Human name of the source for summaries: the file name, else the API input's last segment, else "content". */
export function sourceLabel(src: SourceInput): string {
  return src.fileName ?? (src.input !== undefined ? inputBaseName(src.input) ?? redactInput(src.input) : undefined) ?? "content";
}

/** §4.2: path → base64 of raw bytes with fileName=basename; inline content validated. */
export async function loadSource(deps: Deps, args: { content?: string; contentEncoding?: "text" | "base64"; path?: string; fileName?: string; input?: string }, caps: Caps, call?: CallCtx): Promise<SourceInput> {
  if (args.input !== undefined) {
    return { input: args.input, content: "", contentEncoding: "text", fileName: args.fileName, size: 0 };
  }
  const cap = inputCap(caps);
  if (args.path !== undefined) {
    const r = await deps.guard.resolveInputFile(args.path, (name) => deps.extensions.check(name, "read", call));
    const nodePath = await import("node:path");
    const fileName = args.fileName ?? nodePath.basename(args.path);
    const readCap = cap;
    if (r.size > readCap.value) throw tooLarge(args.path, readCap, r.size);
    const bytes = await readFileChecked(r.real, args.path, readCap);
    return { content: bytes.toString("base64"), contentEncoding: "base64", fileName, size: bytes.length, real: r.real, callerPath: args.path, bytes, ext: nodePath.extname(fileName).toLowerCase() };
  }
  const content = args.content ?? "";
  const enc = args.contentEncoding ?? "text";
  let size: number;
  if (enc === "base64") {
    if (!isValidBase64(content)) throw mcpError("invalid-base64", "`content` is not valid base64 (standard alphabet, padded, no whitespace).", "Send binary files via `path` instead of base64 when you can.");
    size = decodedBase64Length(content);
  } else size = Buffer.byteLength(content, "utf8");
  if (size > cap.value) throw tooLarge("The inline content", cap, size, deps.pathsInSchema ? "Split the file, or pass it via `path`." : "Split the file.");
  const nodePath = await import("node:path");
  return { content, contentEncoding: enc, fileName: args.fileName, size, ext: args.fileName ? nodePath.extname(args.fileName).toLowerCase() : undefined };
}

/** §4.3: profilePath → parsed JSON profile. */
export async function loadProfile(deps: Deps, args: { profile?: Record<string, unknown>; profilePath?: string }, caps: Caps): Promise<Record<string, unknown> | undefined> {
  if (args.profilePath === undefined) {
    if (args.profile && caps.maxProfile) {
      const n = Buffer.byteLength(JSON.stringify(args.profile));
      if (n > caps.maxProfile) throw tooLarge("The profile", { name: "maxProfileBytes", value: caps.maxProfile }, n, "Simplify the profile.");
    }
    return args.profile;
  }
  const r = await deps.guard.resolveInputFile(args.profilePath);
  const cap = caps.maxProfile ? { name: "maxProfileBytes", value: caps.maxProfile } : undefined;
  const bytes = await readFileChecked(r.real, args.profilePath, cap);
  try {
    const v = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("the profile must be a JSON object");
    return v as Record<string, unknown>;
  } catch (e) {
    throw mcpError("invalid-arguments", `profilePath ${args.profilePath} is not valid JSON: ${(e as Error).message}`, "Fix the JSON, then check it with validate_profile.");
  }
}

export function ebuSizeWarning(src: SourceInput, caps: Caps): WarningT[] {
  if (src.ext === ".stl" && caps.ebuStlMaxBytes && src.size > caps.ebuStlMaxBytes) {
    return [{ code: "mcp-ebu-size", message: `The .stl file is ${src.size} bytes, more than the EBU STL limit of ${caps.ebuStlMaxBytes}; if it is EBU STL it may be rejected (Avid STL shares the extension).` }];
  }
  return [];
}

// ---------- shared output shapes ----------

export const DetectedOutput = z.object({
  format: z.string(),
  id: z.string(),
  kind: z.enum(["text", "binary"]).optional(),
  encoding: z.string(),
  encodingConfidence: z.string(),
  language: z.string().nullish(),
  paragraphs: z.number().int(),
  candidates: z.array(z.string()).nullish(),
  codePage: z.string().optional(),
  formatDetails: z.record(z.string(), z.unknown()).optional(),
  /** detect_format only (API 1.2.0): BOM and line endings of a text source. */
  bom: z.boolean().optional(),
  lineEndings: z.enum(["crlf", "lf", "cr", "mixed", "none"]).optional(),
});

const CueList = z.object({ total: z.number().int(), cues: z.array(z.number().int()) });
/** API 1.2.0: read-back check of a binary output (positions and code points only, never cue text). */
export const Verification = z.object({
  verdict: z.enum(["lossless", "quantised", "lossy", "unverified"]),
  cuesWritten: z.number().int(),
  cuesReadBack: z.number().int().optional(),
  timing: z.object({ maxShiftMs: z.number(), meanShiftMs: z.number(), frameMs: z.number(), cuesOverOneFrame: z.number().int() }).optional(),
  replacedChars: z
    .object({
      total: z.number().int(), cueCount: z.number().int(), cues: z.array(z.number().int()), distinctCodePoints: z.number().int(),
      codePoints: z.array(z.object({ codePoint: z.string(), count: z.number().int() })),
    })
    .optional(),
  truncatedCues: CueList.optional(),
  missingCues: CueList.optional(),
  zeroLengthCues: CueList.optional(),
  reason: z.string().optional(),
});
export type VerificationT = z.infer<typeof Verification>;

const int = (v: unknown) => toInt(v);
const ints = (v: unknown) => (Array.isArray(v) ? v.map(int) : []);
const cueList = (v: any) => (v && typeof v === "object" ? { total: int(v.total), cues: ints(v.cues) } : undefined);
const codePoints = (v: unknown) =>
  Array.isArray(v) ? v.filter((c) => c && typeof c === "object").map((c: any) => ({ codePoint: String(c.codePoint ?? ""), count: int(c.count) })) : [];
const VERDICTS = new Set(["lossless", "quantised", "lossy", "unverified"]);

export function mapVerification(v: any): VerificationT | undefined {
  if (!v || typeof v !== "object" || !VERDICTS.has(v.verdict)) return undefined;
  const out: VerificationT = { verdict: v.verdict, cuesWritten: int(v.cuesWritten) };
  if (v.cuesReadBack != null) out.cuesReadBack = int(v.cuesReadBack);
  if (v.timing && typeof v.timing === "object") {
    const t = v.timing;
    out.timing = { maxShiftMs: Number(t.maxShiftMs) || 0, meanShiftMs: Number(t.meanShiftMs) || 0, frameMs: Number(t.frameMs) || 0, cuesOverOneFrame: int(t.cuesOverOneFrame) };
  }
  if (v.replacedChars && typeof v.replacedChars === "object") {
    const r = v.replacedChars;
    out.replacedChars = { total: int(r.total), cueCount: int(r.cueCount), cues: ints(r.cues), distinctCodePoints: int(r.distinctCodePoints), codePoints: codePoints(r.codePoints) };
  }
  for (const k of ["truncatedCues", "missingCues", "zeroLengthCues"] as const) {
    const l = cueList(v[k]);
    if (l) out[k] = l;
  }
  if (typeof v.reason === "string") out.reason = v.reason.slice(0, 500);
  return out;
}

const cuesText = (l: { total: number; cues: number[] }) => `${l.cues.join(", ")}${l.total > l.cues.length ? ", …" : ""}`;

/** One compact line, e.g. "lossy: 3/3 cues read back; 50 chars replaced in cues 1, 2, 3 (U+03B1×5, …); timing max 13 ms (frame 41.7 ms)". */
export function verificationText(v: VerificationT): string {
  if (v.verdict === "unverified") return `unverified (${v.reason ?? "the read-back failed"})`;
  const parts = [`${v.cuesReadBack ?? "?"}/${v.cuesWritten} cues read back`];
  if (v.missingCues?.total) parts.push(`${v.missingCues.total} cue(s) missing: ${cuesText(v.missingCues)}`);
  if (v.replacedChars?.total) {
    const r = v.replacedChars;
    const cps = r.codePoints.slice(0, 3).map((c) => `${c.codePoint}×${c.count}`).join(", ");
    parts.push(`${r.total} char(s) replaced in cue(s) ${cuesText({ total: r.cueCount, cues: r.cues })}${cps ? ` (${cps}${r.distinctCodePoints > 3 ? ", …" : ""})` : ""}`);
  }
  if (v.truncatedCues?.total) parts.push(`text truncated in cue(s) ${cuesText(v.truncatedCues)}`);
  if (v.zeroLengthCues?.total) parts.push(`zero-length cue(s) ${cuesText(v.zeroLengthCues)} not stored at their own time`);
  if (v.timing) parts.push(`timing max ${v.timing.maxShiftMs} ms, mean ${v.timing.meanShiftMs} ms (frame ${v.timing.frameMs} ms${v.timing.cuesOverOneFrame ? `; ${v.timing.cuesOverOneFrame} cue(s) moved more than a frame` : ""})`);
  return `${v.verdict}: ${parts.join("; ")}`;
}

export function mapDetected(d: any): z.infer<typeof DetectedOutput> | null {
  if (!d || typeof d !== "object") return null;
  const out: z.infer<typeof DetectedOutput> = {
    format: String(d.format ?? ""),
    id: String(d.id ?? ""),
    encoding: String(d.encoding ?? ""),
    encodingConfidence: String(d.encodingConfidence ?? ""),
    language: d.language ?? null,
    paragraphs: toInt(d.paragraphs),
  };
  if (d.kind === "text" || d.kind === "binary") out.kind = d.kind;
  if (Array.isArray(d.candidates)) out.candidates = d.candidates.map(String);
  if (typeof d.codePage === "string") out.codePage = d.codePage;
  if (d.formatDetails && typeof d.formatDetails === "object") out.formatDetails = d.formatDetails;
  if (typeof d.bom === "boolean") out.bom = d.bom;
  if (["crlf", "lf", "cr", "mixed", "none"].includes(d.lineEndings)) out.lineEndings = d.lineEndings;
  return out;
}

export function mapWarnings(ws: unknown): WarningT[] {
  if (!Array.isArray(ws)) return [];
  return ws.filter((w) => w && typeof w === "object").map((w: any) => {
    const out: WarningT = { code: String(w.code ?? "warning"), message: String(w.message ?? "") + (w.count !== undefined && w.count !== null ? ` (count ${toInt(w.count)})` : "") };
    if (typeof w.hint === "string" && w.hint) out.hint = w.hint;
    const d = w.details;
    if (d && typeof d === "object") {
      const det: NonNullable<WarningT["details"]> = {};
      if (d.cueCount != null) det.cueCount = toInt(d.cueCount);
      if (Array.isArray(d.cues)) det.cues = ints(d.cues);
      if (d.distinctCodePoints != null) det.distinctCodePoints = toInt(d.distinctCodePoints);
      if (Array.isArray(d.codePoints)) det.codePoints = codePoints(d.codePoints);
      if (Array.isArray(d.durations))
        det.durations = d.durations.filter((x: any) => x && typeof x === "object").slice(0, 50).map((x: any) => ({ cue: int(x.cue), durationMs: Number(x.durationMs) || 0 }));
      if (d.fields && typeof d.fields === "object" && !Array.isArray(d.fields))
        det.fields = Object.fromEntries(Object.entries(d.fields).slice(0, 20).map(([k, v]) => [k.slice(0, 100), String(v).slice(0, 200)]));
      if (typeof d.timecode === "string") det.timecode = d.timecode.slice(0, 20);
      const fr = typeof d.frameRate === "number" ? d.frameRate : typeof d.frameRate === "string" ? Number(d.frameRate) : NaN;
      if (Number.isFinite(fr)) det.frameRate = fr;
      const rm = mapRemedy(d.remedy);
      if (rm) det.remedy = rm;
      if (Object.keys(det).length) out.details = det;
    }
    return out;
  });
}

const strs = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 100)).slice(0, 50) : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 500) : undefined);

function mapRemedy(r: any): NonNullable<WarningT["details"]>["remedy"] | undefined {
  if (!r || typeof r !== "object") return undefined;
  const out: NonNullable<NonNullable<WarningT["details"]>["remedy"]> = {
    scripts: strs(r.scripts) ?? [], currentEncoding: String(r.currentEncoding ?? ""), candidatesTested: r.candidatesTested === true, unicodeAlternative: String(r.unicodeAlternative ?? "fpc"),
  };
  for (const k of ["detectedLanguage", "option", "currentValue", "suggested", "note"] as const) {
    const v = str(r[k]);
    if (v) out[k] = v;
  }
  for (const k of ["allowedValues", "candidates"] as const) {
    const v = strs(r[k]);
    if (v) out[k] = v;
  }
  return out;
}

/** "code: message (hint: …)" for summaries. */
export function warningText(w: WarningT): string {
  const r = w.details?.remedy;
  const opts = !w.hint && r?.option && r.candidates?.length ? ` (options for ${r.option}: ${r.candidates.join(", ")}; or target ${r.unicodeAlternative})` : "";
  return `${w.code}: ${w.message}${w.hint ? ` (hint: ${w.hint})` : opts}`;
}

export function fieldErrors(v: unknown): z.infer<typeof FieldError>[] {
  if (!Array.isArray(v)) return [];
  return v.filter((e) => e && typeof e === "object").map((e: any) => ({ pointer: String(e.pointer ?? ""), message: String(e.message ?? ""), ...(typeof e.hint === "string" ? { hint: e.hint } : {}) }));
}

export const asToolError = (e: ToolError) => e;
export const ZAny: ZodTypeAny = z.unknown();
