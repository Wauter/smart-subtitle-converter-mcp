import { z } from "zod";

export const FieldError = z.object({ pointer: z.string(), message: z.string(), hint: z.string().nullish() });
/** API 1.2.0: cue numbers (1-based, first 20) and code points; never cue text. */
export const WarningDetails = z.object({
  cueCount: z.number().int().optional(),
  cues: z.array(z.number().int()).optional(),
  distinctCodePoints: z.number().int().optional(),
  codePoints: z.array(z.object({ codePoint: z.string(), count: z.number().int() })).optional(),
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
export const Warning = z.object({ code: z.string(), message: z.string(), hint: z.string().optional(), details: WarningDetails.optional() });
export const ToolErrorSchema = z.object({
  source: z.enum(["api", "mcp"]),
  status: z.number().int().optional(),
  code: z.string(),
  title: z.string().optional(),
  detail: z.string().optional(),
  hint: z.string().optional(),
  requestId: z.string().optional(),
  jobId: z.string().optional(),
  jobUrl: z.string().optional(),
  errors: z.array(FieldError).optional(),
  retryAfterSeconds: z.number().optional(),
  attempts: z.number().int().optional(),
  limit: z.object({ name: z.string(), value: z.number(), actual: z.number() }).optional(),
  /** ambiguous-format: the format ids the bytes match. */
  candidates: z.array(z.string()).optional(),
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
  "input-limits-exceeded": "Split the file.",
  "conversion-failed": "Try removing the named operation from the profile.",
  "rate-limited": "The API is rate limited; try again later.",
  "queue-full": "The converter is busy; retry later or ask the operator to scale out.",
  "internal-error": "This is a server bug; report the requestId.",
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
  if (Array.isArray(b.errors)) {
    te.errors = b.errors
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e) => ({
        pointer: String(e.pointer ?? ""),
        message: String(e.message ?? ""),
        ...(typeof e.hint === "string" ? { hint: e.hint } : {}),
      }));
  }
  if (Array.isArray(b.candidates)) te.candidates = b.candidates.map(String);
  if (typeof b.phase === "string") te.phase = b.phase;
  if (ctx.includeDebug && ctx.mode !== "hosted" && b.debug !== undefined) te.debug = b.debug;

  let mcpHint: string | undefined = MCP_HINTS[apiCode];
  switch (apiCode) {
    case "unauthorized":
      mcpHint =
        ctx.mode === "local"
          ? "Set SUBTITLE_API_KEY."
          : "The MCP's SUBTITLE_API_KEY (or _FILE) is missing or wrong; ask the operator.";
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
    case "format-not-supported":
      mcpHint = "Pick a format from list_formats.";
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

/** Text block for an error result: "<code>: <detail>\nHint: <hint>\nrequestId: <id>". */
export function errorText(e: ToolError): string {
  let s = `${e.code}: ${e.detail ?? e.title ?? "error"}`;
  if (e.errors?.length) s += "\n" + e.errors.slice(0, 10).map((x) => `  ${x.pointer}: ${x.message}${x.hint ? ` (${x.hint})` : ""}`).join("\n");
  if (e.candidates?.length) s += `\nCandidates: ${e.candidates.join(", ")}`;
  if (e.osError) s += `\nOS error: ${e.osError.code}${e.osError.syscall ? ` (${e.osError.syscall})` : ""}`;
  if (e.limit) s += `\nLimit ${e.limit.name}=${e.limit.value}, actual ${e.limit.actual}`;
  if (e.retryAfterSeconds !== undefined) s += `\nRetry after: ${e.retryAfterSeconds}s`;
  if (e.hint) s += `\nHint: ${e.hint}`;
  if (e.requestId) s += `\nrequestId: ${e.requestId}`;
  return s;
}
