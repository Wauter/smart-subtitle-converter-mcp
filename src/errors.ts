import { pathToFileURL } from "node:url";
import { z } from "zod";

export const FieldError = z.object({ pointer: z.string(), message: z.string(), hint: z.string().nullish() });
/** API 1.2.0: cue numbers (1-based, first 20) and code points; never cue text. */
export const WarningDetails = z.object({
  cueCount: z.number().int().optional(),
  cues: z.array(z.number().int()).optional(),
  distinctCodePoints: z.number().int().optional(),
  codePoints: z.array(z.object({ codePoint: z.string(), count: z.number().int() })).optional(),
  /** long-cue: source cue number and duration (ms). */
  durations: z.array(z.object({ cue: z.number().int(), durationMs: z.number() })).optional(),
  /** format-defaults-applied: header field → value the writer filled in. */
  fields: z.record(z.string(), z.string()).optional(),
  /** programme-start-not-applied: the EBU STL TCP, HH:MM:SS:FF. */
  timecode: z.string().optional(),
  /** API 1.2.1, characters-replaced: the facts to choose a fix (option, allowed values, tested candidates). */
  remedy: z
    .object({
      scripts: z.array(z.string()),
      detectedLanguage: z.string().optional(),
      currentEncoding: z.string(),
      option: z.string().optional(),
      currentValue: z.string().optional(),
      allowedValues: z.array(z.string()).optional(),
      candidates: z.array(z.string()).optional(),
      candidatesTested: z.boolean(),
      suggested: z.string().optional(),
      unicodeAlternative: z.string(),
      note: z.string().optional(),
    })
    .optional(),
});
/** ambiguous-encoding with probe text-encoding: one encoding that still reads as words, with a short decoded sample. */
export const EncodingCandidate = z.object({
  encoding: z.string(),
  language: z.string().nullish(),
  hits: z.number().int().optional(),
  sample: z.string().optional(),
});
/** Strings (format ids, PAC code pages) or text-encoding objects. */
export const Candidate = z.union([z.string(), EncodingCandidate]);
export type CandidateT = z.infer<typeof Candidate>;
export const Warning = z.object({ code: z.string(), message: z.string(), hint: z.string().optional(), details: WarningDetails.optional() });
export const ToolErrorSchema = z.object({
  source: z.enum(["api", "mcp"]),
  status: z.number().int().optional(),
  code: z.string(),
  title: z.string().optional(),
  detail: z.string().optional(),
  hint: z.string().optional(),
  requestId: z.string().optional(),
  location: z.string().optional(),
  jobId: z.string().optional(),
  jobUrl: z.string().optional(),
  errors: z.array(FieldError).optional(),
  retryAfterSeconds: z.number().optional(),
  attempts: z.number().int().optional(),
  limit: z.object({ name: z.string(), value: z.number(), actual: z.number() }).optional(),
  /**
   * ambiguous-format: the format ids the bytes match (strings). ambiguous-encoding: PAC code page names (strings) for
   * probe pac-code-page, or {encoding, language, hits, sample} objects for probe text-encoding.
   */
  candidates: z.array(Candidate).optional(),
  /** ambiguous-encoding: which probe could not decide ("pac-code-page" | "text-encoding"). */
  probe: z.string().optional(),
  phase: z.string().optional(),
  /** D-35: the caller-visible path a local failure is about. */
  path: z.string().optional(),
  /** D-35: OS cause, e.g. {code:"ENOSPC", syscall:"write"}. */
  osError: z.object({ code: z.string(), syscall: z.string().optional(), message: z.string() }).optional(),
  debug: z.unknown().optional(),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;
export type WarningT = z.infer<typeof Warning>;
export type FieldErrorT = z.infer<typeof FieldError>;

/** Thrown inside handlers; converted to an isError tool result (or a JSON-RPC error for resources). */
export class ToolFailure extends Error {
  constructor(public readonly toolError: ToolError, public readonly warnings: WarningT[] = []) {
    super(`${toolError.code}: ${toolError.detail ?? toolError.title ?? ""}`);
  }
}

export function mcpError(code: string, detail: string, hint?: string, extra: Partial<ToolError> = {}): ToolFailure {
  return new ToolFailure({ source: "mcp", code, detail, ...(hint ? { hint } : {}), ...extra });
}

export type Mode = "local" | "sidecar" | "hosted";

export interface MapContext {
  mode: Mode;
  includeDebug: boolean;
  /** Which endpoint the problem came from, for 404 handling. */
  endpoint?: string;
  headerRequestId?: string;
}

export const MCP_HINTS: Record<string, string> = {
  "invalid-profile": "Check the profile with validate_profile; format ids come from list_formats.",
  "format-option-invalid": "See `options` in list_formats for the formatOptions block.",
  "preset-not-found": "Use list_presets.",
  "payload-too-large": "Split the file.",
  "format-not-detected": "Set profile.source.format (see list_formats), or run detect_format.",
  "format-not-writable": "Pick a target with list_formats {writableOnly:true}.",
  "invalid-binary-input": "Send binary files via path or base64; set profile.source.format if the wrong format was detected.",
  "encoding-error": "Set profile.encoding.input.",
  "ambiguous-format":
    "The file matches both PAC and Unicode PAC (FPC). Pass profile.source.format ('pac' or 'fpc'), or give the file its .pac or .fpc name.",
  "ambiguous-encoding":
    "The API could not tell the character set from the file's words. Pass the right one from candidates (or the file's known language) in profile.formatOptions.pac.inputCodePage (PAC) or profile.encoding.input (text), or save text as UTF-8.",
  "input-limits-exceeded": "Split the file.",
  "conversion-failed": "Try removing the named operation from the profile.",
  "rate-limited": "The API is rate limited; try again later.",
  "queue-full": "The converter is busy; retry later or ask the operator to scale out.",
  "internal-error": "This is a server bug; report the requestId.",
  "browse-busy": "The API is busy listing and reading other files; retry after Retry-After.",
  "conversion-engine-stuck": "A previous conversion is stuck; the API refuses new ones until it finishes or restarts itself. Retry after Retry-After.",
  "host-not-allowed": "The API doesn't accept the host name in SUBTITLE_API_URL; ask the operator to add it to the API's ALLOWED_HOSTS.",
  "origin-not-allowed": "The API refused a browser Origin header; this MCP never sends one, so check any proxy in between.",
};

function joinHints(a?: string, b?: string): string | undefined {
  if (a && b) return `${a} ${b}`;
  return a || b || undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return undefined;
}

/** Reads the 504 phase ([A11]). Missing or unknown counts as running (no blind retry). */
export function timeoutPhase(body: unknown): "queue" | "running" {
  const p = body && typeof body === "object" ? (body as Record<string, unknown>).phase : undefined;
  return p === "queue" ? "queue" : "running";
}

/**
 * Maps an API problem (or an empty / non-problem error body) to a ToolError, per spec §8.1.
 * `body` is the parsed JSON (or undefined when empty or unparseable).
 */
export function mapProblem(status: number, body: unknown, ctx: MapContext): ToolError {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  const requestId = (typeof b?.requestId === "string" ? b.requestId : undefined) ?? ctx.headerRequestId;
  const base: ToolError = { source: "api", status, code: "", ...(requestId ? { requestId } : {}) };

  if (!b) {
    // D-36: no special handling of old quirks; an empty or non-problem error body is a protocol error.
    return { ...base, code: "api-protocol-error", title: `http-${status}`, detail: `The API returned HTTP ${status} without a problem body.`, hint: "Check SUBTITLE_API_URL and the API version; report this with the requestId." };
  }

  const apiCode = typeof b.code === "string" && b.code ? b.code : `http-${status}`;
  const apiHint = typeof b.hint === "string" ? b.hint : undefined;
  const te: ToolError = {
    ...base,
    code: apiCode,
    ...(typeof b.title === "string" ? { title: b.title } : {}),
    ...(typeof b.detail === "string" ? { detail: b.detail } : {}),
  };
  if (typeof b.location === "string") {
    try { const u = b.location.startsWith("/") ? pathToFileURL(b.location) : new URL(b.location); u.username = ""; u.password = ""; u.search = ""; u.hash = ""; te.location = u.href; } catch { /* do not echo malformed locations */ }
  }
  if (typeof b.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(b.id)) {
    te.jobId = b.id;
    te.jobUrl = `/v1/jobs/${b.id}`;
  }
  if (Array.isArray(b.errors)) {
    te.errors = b.errors
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e) => ({
        pointer: String(e.pointer ?? ""),
        message: String(e.message ?? ""),
        ...(typeof e.hint === "string" ? { hint: e.hint } : {}),
      }));
  }
  if (Array.isArray(b.candidates)) te.candidates = mapCandidates(b.candidates);
  if (typeof b.phase === "string") te.phase = b.phase;
  if (typeof b.probe === "string") te.probe = b.probe;
  if (ctx.includeDebug && ctx.mode !== "hosted" && b.debug !== undefined) te.debug = b.debug;

  let mcpHint: string | undefined = MCP_HINTS[apiCode];
  switch (apiCode) {
    case "unauthorized":
      mcpHint =
        ctx.mode === "local"
          ? "Set SUBTITLE_API_KEY, or SUBTITLE_API_KEY_FILE pointing at a file with the key from the API's api_keys.txt (the API generates one there on first start)."
          : "The MCP's SUBTITLE_API_KEY (or _FILE) is missing or wrong; ask the operator. The API's api_keys.txt holds the key.";
      break;
    case "not-found":
      if (ctx.endpoint !== "/v1/limits") {
        te.code = "api-protocol-error";
        te.title = te.title ?? "not-found";
        mcpHint = "Check SUBTITLE_API_URL and the API version.";
      }
      break;
    case "unsupported-media-type":
      te.code = "api-protocol-error";
      mcpHint = "Report this with the requestId.";
      break;
    case "frame-rate-required":
      mcpHint = "Don't guess the rate: take it from the user, the file name or the delivery spec, and ask the user if none says.";
      break;
    case "format-not-supported":
      mcpHint = "Pick a format from list_formats.";
      break;
    case "ambiguous-encoding":
      if (b.probe === "pac-code-page")
        mcpHint = "Pass profile.formatOptions.pac.inputCodePage (one of candidates, or the code page for the file's language, e.g. 'greek').";
      else if (b.probe === "text-encoding")
        mcpHint = "Pass profile.encoding.input (one of candidates), or save the file as UTF-8.";
      break;
    case "conversion-timeout":
      mcpHint =
        timeoutPhase(b) === "queue"
          ? "The converter is overloaded; retry later."
          : "Split the file (e.g. by time range) or simplify the operations.";
      break;
  }
  const hint = joinHints(apiHint, mcpHint);
  if (hint) te.hint = hint;
  const ra = num(b.retryAfterSeconds);
  if (ra !== undefined) te.retryAfterSeconds = ra;
  return te;
}

/** Keeps strings and text-encoding objects structurally (bounded); drops anything else. */
export function mapCandidates(v: unknown[]): CandidateT[] {
  const out: CandidateT[] = [];
  for (const c of v.slice(0, 50)) {
    if (typeof c === "string" || typeof c === "number") out.push(String(c).slice(0, 100));
    else if (c && typeof c === "object" && typeof (c as any).encoding === "string") {
      const o = c as Record<string, unknown>;
      const hits = typeof o.hits === "number" ? Math.trunc(o.hits) : typeof o.hits === "string" && /^\d+$/.test(o.hits) ? Number(o.hits) : undefined;
      out.push({
        encoding: (o.encoding as string).slice(0, 100),
        ...(typeof o.language === "string" ? { language: o.language.slice(0, 50) } : o.language === null ? { language: null } : {}),
        ...(hits !== undefined ? { hits } : {}),
        ...(typeof o.sample === "string" ? { sample: o.sample.slice(0, 500) } : {}),
      });
    }
  }
  return out;
}

/** "windows-1256 (ar, 12 words): \"sample\"" for an object candidate; strings as they are. */
export function candidateText(c: CandidateT): string {
  if (typeof c === "string") return c;
  const facts = [c.language, c.hits !== undefined ? `${c.hits} word${c.hits === 1 ? "" : "s"}` : undefined].filter(Boolean).join(", ");
  return `${c.encoding}${facts ? ` (${facts})` : ""}${c.sample ? `: ${JSON.stringify(c.sample)}` : ""}`;
}

/** Text block for an error result: "<code>: <detail>\nHint: <hint>\nrequestId: <id>". */
export function errorText(e: ToolError): string {
  let s = `${e.code}: ${e.detail ?? e.title ?? "error"}`;
  // A single field error is already spelled out in detail ("Invalid arguments: /which: …"); don't repeat it.
  const single = e.errors?.length === 1 && e.detail?.includes(`${e.errors[0].pointer}: ${e.errors[0].message}`);
  if (e.errors?.length && !single) s += "\n" + e.errors.slice(0, 10).map((x) => `  ${x.pointer}: ${x.message}${x.hint ? ` (${x.hint})` : ""}`).join("\n");
  if (e.candidates?.length) {
    s += e.candidates.some((c) => typeof c !== "string")
      ? `\nCandidates:\n${e.candidates.map((c) => `  - ${candidateText(c)}`).join("\n")}`
      : `\nCandidates: ${e.candidates.join(", ")}`;
  }
  if (e.probe) s += `\nProbe: ${e.probe}`;
  if (e.osError) s += `\nOS error: ${e.osError.code}${e.osError.syscall ? ` (${e.osError.syscall})` : ""}`;
  if (e.limit) s += `\nLimit ${e.limit.name}=${e.limit.value}, actual ${e.limit.actual}`;
  if (e.retryAfterSeconds !== undefined) s += `\nRetry after: ${e.retryAfterSeconds}s`;
  if (e.hint) s += `\nHint: ${e.hint}`;
  if (e.location) s += `\nLocation: ${e.location}`;
  if (e.jobId) s += `\njobId: ${e.jobId}${e.jobUrl ? ` (${e.jobUrl})` : ""}`;
  if (e.requestId) s += `\nrequestId: ${e.requestId}`;
  return s;
}
