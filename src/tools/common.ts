import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ContentBlock, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { errorText, FieldError, mcpError, ToolFailure, Warning, type ToolError, type WarningT } from "../errors.js";
import { newCallId, withSuffix } from "../ids.js";
import { newStats } from "../api/client.js";
import { capsFrom, type Caps } from "../api/limits.js";
import { toInt } from "../api/coerce.js";
import type { Call, Deps } from "../context.js";
import { isValidBase64, decodedBase64Length } from "../base64.js";
import { readFileChecked } from "../fs/guard.js";
import { mcpErrorFromZod } from "./zodError.js";
import { apiInfo, mismatchWarning } from "../api/info.js";
import { probeApi } from "../probe.js";

export { FieldError, Warning };

export interface ToolOutcome {
  structured: Record<string, unknown>;
  summary: string;
  blocks?: ContentBlock[];
  logFields?: Record<string, unknown>;
}

export interface ToolDef<S extends ZodRawShape> {
  name: string;
  title: string;
  /** A function when the text depends on the allowed folders: it's rebuilt after a client-roots change. */
  description: string | (() => string);
  shape: S;
  output: ZodRawShape;
  annotations: ToolAnnotations;
  /** structured.warnings is a Warning[] ({code,message}); the version-mismatch warning may be added there. */
  warningArray?: boolean;
  handler: (args: z.infer<z.ZodObject<S>>, call: Call) => Promise<ToolOutcome>;
}

/** Per server: tools whose description is rebuilt when the allowed folders change. */
const dynamicDescriptions = new WeakMap<McpServer, { tool: RegisteredTool; describe: () => string }[]>();

/**
 * Rebuilds the folder-dependent tool descriptions from the current roots. When any changed (and the server is
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
export function defineTool<S extends ZodRawShape>(server: McpServer, deps: Deps, def: ToolDef<S>): void {
  const strict = z.object(def.shape).strict();
  const describe = typeof def.description === "function" ? def.description : undefined;
  const registered = server.registerTool(
    def.name,
    {
      title: def.title,
      description: describe ? describe() : (def.description as string),
      inputSchema: strict as unknown as S,
      outputSchema: def.output,
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
        if (!parsed.success) throw mcpErrorFromZod(parsed.error);
        const out = await def.handler(parsed.data as any, call);
        Object.assign(call.log, out.logFields ?? {});
        const mm = mismatchWarning();
        if (mm) {
          // §10 [DC]: the short version-mismatch warning rides on results while the mismatch persists.
          if (def.warningArray) {
            if (!Array.isArray(out.structured.warnings)) out.structured.warnings = [];
            (out.structured.warnings as WarningT[]).push(mm);
          }
          out.summary += `\nWarning ${mm.code}: ${mm.message}`;
        }
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
        const mm = mismatchWarning();
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

export function checkDestructive(deps: Deps, ifExists: string | undefined): void {
  if ((ifExists === "replace" || ifExists === "delete") && !deps.cfg.allowDestructive) {
    throw mcpError(
      "destructive-not-allowed",
      `ifExists "${ifExists}" is disabled on this server.`,
      "The operator can enable it with SUBTITLE_MCP_ALLOW_DESTRUCTIVE=true; `archive` keeps the old file as a .bak and is always allowed.",
    );
  }
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

/** §4.2: path → base64 of raw bytes with fileName=basename; inline content validated. */
export async function loadSource(deps: Deps, args: { content?: string; contentEncoding?: "text" | "base64"; path?: string; fileName?: string }, caps: Caps): Promise<SourceInput> {
  const cap = inputCap(caps);
  if (args.path !== undefined) {
    const r = await deps.guard.resolveInputFile(args.path);
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
  formatDetails: z.record(z.unknown()).optional(),
});

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
  return out;
}

export function mapWarnings(ws: unknown): WarningT[] {
  if (!Array.isArray(ws)) return [];
  return ws.filter((w) => w && typeof w === "object").map((w: any) => ({ code: String(w.code ?? "warning"), message: String(w.message ?? "") + (w.count !== undefined && w.count !== null ? ` (count ${toInt(w.count)})` : "") }));
}

export function fieldErrors(v: unknown): z.infer<typeof FieldError>[] {
  if (!Array.isArray(v)) return [];
  return v.filter((e) => e && typeof e === "object").map((e: any) => ({ pointer: String(e.pointer ?? ""), message: String(e.message ?? ""), ...(typeof e.hint === "string" ? { hint: e.hint } : {}) }));
}

export const asToolError = (e: ToolError) => e;
export const ZAny: ZodTypeAny = z.unknown();
