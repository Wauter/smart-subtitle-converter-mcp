import { z } from "zod";
import { pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Call, Deps } from "../context.js";
import { ToolFailure, mcpError, type WarningT } from "../errors.js";
import path from "node:path";
import { defineTool, getCaps, inputCap, inputScheme, mapWarnings, redactInput, tooLarge, Warning } from "./common.js";
import { readFileChecked } from "../fs/guard.js";
import type { PreviewEntry } from "./previewCache.js";
import { isRemote, remoteState, remoteUnavailable, staleGate } from "./storage.js";
import { sanitizeOutputName } from "../fs/write.js";
import { withSuffix } from "../ids.js";
import { finishConversion } from "../api/jobs.js";
import type { Caps } from "../api/limits.js";
import { checkCursor, clampPageBytes, decodeCursor, encodeCursor, fingerprint, hashKey, locationBaseName, PREVIEW_HARD_CEILING_BYTES, PREVIEW_MIN_BYTES, segment, sourceChanged, stripBom, takePage } from "./textPage.js";

export function describePreviewText(deps: Deps): string {
  const c = deps.cfg;
  const what = c.listEnabled
    ? "Read the subtitle text of a file. `location` takes the file's full URI (s3://bucket/key or file:///path, on the converter API's side) or an absolute local path in this server's allowed folders, exactly as list_files returns it in items[].location; for example s3://subs/show.srt, s3://subs/show.srt.json (a convert_subtitle sidecar: the output URI plus .json), file:///data/out/show.vtt or /home/me/subs/show.srt. Or give `jobId` and `which` (input | output) for a convert_subtitle job's stored file. API URIs need browsing on the converter API (list_allowed_folders `remote.state` on); local paths and job ids work either way. Use it to check spelling, language and timing: a read-only text preview, never bytes to save."
    : "Read the subtitle text of a convert_subtitle job's stored input or output, to check spelling, language and timing. This is a read-only text preview for you, not the file: it never returns bytes to save. Give `jobId` and `which` (input | output); files are reachable only by job id, never by URI.";
  return what +
    " Text formats are returned as stored. Binary formats (EBU STL, PAC, Cavena 890, …) are converted to SRT for reading: `convertedFrom` is the stored format id, `convertedTo` is 'srt', and `warnings` say what the SRT view lost or changed; the file is never modified. Formats that store frame numbers without a frame rate (PAC, Cavena 890, …) need one for the SRT times: a job's file reuses the rate the job used, otherwise pass `fps` (the call fails with `frame-rate-required` when none is known)." +
    ` The text is paged and the result's \`text\` holds one page. SRT and WebVTT pages always end on a whole cue, other text on a whole line. \`maxBytes\` sets the page size in UTF-8 bytes (default ${c.previewDefaultBytes}, clamped to ${PREVIEW_MIN_BYTES}..${c.previewMaxBytes}, with a max-bytes-clamped warning; later pages keep the first page's size unless you set maxBytes again); only a single cue larger than maxBytes is returned alone over it.` +
    ` When \`truncated\` is true, more text follows: call again with the same ${c.listEnabled ? "location (or jobId and which)" : "jobId and which"} (and \`fps\`, if you gave one) and \`cursor\` set to \`next\` (you may change maxBytes or omit it to keep the page size). \`fromCue\`/\`toCue\` (or \`fromLine\`/\`toLine\`), \`totalCues\` (or \`totalLines\`), \`returnedBytes\` and \`totalBytes\` say where you are; tell the user when you only read part of a file. If the file changes between pages the call fails with \`preview-source-changed\`, and a cursor that wasn't returned for the same ${c.listEnabled ? "location or job file" : "jobId and which"} fails with \`preview-cursor-invalid\`: start again without cursor.` +
    " Each call checks the current file first (local: size and modification time; API: the file's ETag) and re-reads it when it changed; unchanged text may come from a short-lived in-memory cache. Files may change or disappear. Local path uploads and inline content have no stored job input, and a conversion without an API `output` has no stored job output. Any valid API key knowing the unguessable job id can read it. Query-redacted HTTPS locations cannot be replayed.";
}

const count = z.number().int().nonnegative();

export const PreviewTextOutput = {
  source: z.enum(["job", "local", "remote"]).describe("job: a convert_subtitle job's stored file; local: a file in this server's allowed folders; remote: an API storage location"),
  jobId: z.string().optional().describe("source job: the job id the file belongs to"),
  which: z.enum(["input", "output"]).optional().describe("source job: which of the job's stored files was read"),
  fileName: z.string().describe("Name of the file (last segment of its location)"),
  mediaType: z.string().describe("Media type of the file (as the API reported it, or from the extension for local files)"),
  bytes: count.describe("Size of the stored file in bytes (before any SRT conversion)"),
  location: z.string().describe("The file's location (local path or API URI), with any credentials or query removed"),
  format: z.string().optional().describe("Format id of the stored file, when the job recorded it"),
  text: z.string().describe("One page of the text (SRT when convertedFrom is set), ending on a whole cue or line; no BOM"),
  unit: z.enum(["cue", "line"]).describe("How pages are cut: whole cues (SRT, WebVTT) or whole lines (other text)"),
  maxBytes: count.describe("The page size in effect after clamping, in UTF-8 bytes"),
  truncated: z.boolean().describe("true when more text follows this page; pass `next` as `cursor` to read it"),
  next: z.string().optional().describe("Opaque cursor for the next page; present only when truncated is true"),
  returnedBytes: count.describe("UTF-8 bytes of `text` (no BOM)"),
  totalBytes: count.describe("UTF-8 bytes of the whole text (no BOM)"),
  fromCue: count.optional().describe("unit cue: 1-based number of the first cue on this page"),
  toCue: count.optional().describe("unit cue: 1-based number of the last cue on this page"),
  returnedCues: count.optional().describe("unit cue: number of cues on this page"),
  totalCues: count.optional().describe("unit cue: number of cues in the whole text"),
  fromLine: count.optional().describe("unit line: 1-based number of the first line on this page"),
  toLine: count.optional().describe("unit line: 1-based number of the last line on this page"),
  returnedLines: count.optional().describe("unit line: number of lines on this page"),
  totalLines: count.optional().describe("unit line: number of lines in the whole text"),
  convertedFrom: z.string().optional().describe("Set when a binary file was converted to SRT for reading: the stored format id"),
  convertedTo: z.literal("srt").optional().describe("Set with convertedFrom: the text is SRT"),
  warnings: z.array(Warning).describe("max-bytes-clamped when the requested maxBytes was out of range, and warnings from the SRT conversion of a binary file (what the SRT view lost)"),
  requestId: z.string().optional().describe("API request id of the last API call, for support"),
};

export function registerPreviewTextTool(server: McpServer, deps: Deps): void {
  const listing = deps.cfg.listEnabled;
  const jobId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).describe("Job id (`jobId`) returned by convert_subtitle");
  const which = z.enum(["input", "output"]).describe("input | output: the job's stored source or its stored result");
  defineTool(server, deps, {
    name: "preview_text", title: "Preview subtitle text", warningArray: true,
    description: () => describePreviewText(deps),
    shape: {
      ...(listing
        ? {
            location: z.string().min(1).max(16384).optional().describe("The file's full URI or absolute path, as list_files items[].location: s3://bucket/key, file:///path or /local/path (e.g. s3://subs/show.srt.json). Use instead of jobId and which."),
            jobId: jobId.optional(),
            which: which.optional().describe("input | output, with jobId: the job's stored source or its stored result"),
          }
        : { jobId, which }),
      maxBytes: z.number().int().positive().optional().describe(`Page size in UTF-8 bytes (default ${deps.cfg.previewDefaultBytes}, clamped to ${PREVIEW_MIN_BYTES}..${deps.cfg.previewMaxBytes})`),
      fps: z.number().positive().max(120).optional().describe("Frame rate for binary formats that store frame numbers without one (PAC, Cavena 890, …), used only for the SRT view's times; e.g. 25, 29.97, 23.976. A job's file defaults to the rate the job used"),
      // Validated by decodeCursor, so every malformed cursor is preview-cursor-invalid rather than invalid-arguments.
      cursor: z.string().optional().describe("`next` from the previous page, unchanged, to read the following page; omit for the first page"),
    },
    output: PreviewTextOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: async (a: any, call) => {
      const byJob = a.location === undefined;
      if (listing) {
        // Same shape as a schema error (errors[] pointer + hint), so the model sees which argument to fix.
        const bad = (pointer: string, message: string, hint: string) =>
          mcpError("invalid-arguments", `Invalid arguments: ${pointer}: ${message}`, hint, { errors: [{ pointer, message }] });
        if (a.location !== undefined && (a.jobId !== undefined || a.which !== undefined))
          throw bad(a.jobId !== undefined ? "/jobId" : "/which", "Give either `location`, or `jobId` and `which`, not both.", "location reads a file directly; jobId with which reads a convert_subtitle job's stored file.");
        if (byJob && a.jobId === undefined)
          throw bad("/location", "`location`, or `jobId` with `which`, is required.", "Pass a file location from list_files, or the jobId from convert_subtitle with which input | output.");
        if (byJob && a.which === undefined)
          throw bad("/which", '`which` is required (valid values: "input" | "output").', "Fix the arguments as described and call again.");
      }
      const jobPath = byJob ? `/v1/jobs/${a.jobId}` : undefined;
      try {
        // Decode first: a malformed cursor fails before any API call or file read.
        const cursor = a.cursor !== undefined ? decodeCursor(a.cursor) : undefined;
        // A later page keeps the page size of the first unless this call sets maxBytes.
        const maxBytes = clampPageBytes(a.maxBytes ?? cursor?.m, deps.cfg.previewDefaultBytes, deps.cfg.previewMaxBytes);
        const clampWarning: WarningT[] = a.maxBytes !== undefined && a.maxBytes !== maxBytes ? [{
          code: "max-bytes-clamped",
          message: `maxBytes ${a.maxBytes} is outside the allowed range ${PREVIEW_MIN_BYTES}..${deps.cfg.previewMaxBytes}; pages use ${maxBytes} bytes.`,
          hint: a.maxBytes > maxBytes ? "The server maximum is SUBTITLE_MCP_PREVIEW_MAX_BYTES; the operator can raise it (up to 1048576)." : `Ask for at least ${PREVIEW_MIN_BYTES} bytes.`,
          details: { fields: { requested: String(a.maxBytes), applied: String(maxBytes) } },
        }] : [];
        const caps = await getCaps(deps, call);
        // fps changes the SRT view of a binary file, so it is part of the cache and cursor key.
        const variant = a.fps !== undefined ? `:fps=${a.fps}` : "";
        const src = byJob ? await loadJobFile(deps, call, caps, a.jobId, a.which, variant) : await loadLocation(deps, call, caps, a.location, variant);
        const { fileName, location, known, key } = src;
        let { mediaType, formatId } = src;
        let fp: string, text: string | undefined, bytes: number;
        let warnings: WarningT[] = [];
        let convertedFrom: string | undefined;
        let requestId = src.requestId;
        // H7: a cache hit (unchanged version, or the same bytes) skips decoding and any SRT conversion.
        const hit = src.cached ?? (src.data ? sameContent(deps, key, fingerprint(src.data), src.version) : undefined);
        if (hit) {
          fp = hit.fp; text = hit.text; bytes = hit.bytes; warnings = hit.warnings; convertedFrom = hit.convertedFrom;
          formatId = formatId ?? hit.formatId; mediaType = src.data ? mediaType : hit.mediaType;
          if (cursor && cursor.k === key && cursor.h !== fp) throw sourceChanged();
          call.log.previewCache = "hit";
        } else {
          const data = src.data!;
          fp = fingerprint(data); bytes = data.length;
          // Checked again after segmenting; failing here first avoids a needless SRT conversion.
          if (cursor && cursor.k === key && cursor.h !== fp) throw sourceChanged();
          text = decodeText(data, known);
          if (text === undefined) {
            const c = await convertToSrt(deps, call, caps, { data, fileName, formatId, location, which: a.which ?? "input", profile: src.profile, detected: src.detected, fps: a.fps, local: src.source === "local" });
            text = c.text; warnings = c.warnings; convertedFrom = c.formatId ?? formatId ?? "unknown";
            requestId = c.requestId ?? requestId;
          }
          deps.previewCache.set({ key, version: src.version, fp, text: text as string, bytes, warnings, convertedFrom, formatId, mediaType, requestId });
          call.log.previewCache = "miss";
        }
        const cueFormat = convertedFrom !== undefined || formatId === "subrip" || formatId === "webvtt" || /\.(srt|vtt)$/i.test(fileName);
        const seg = segment(stripBom(text as string), cueFormat);
        if (cursor) checkCursor(cursor, key, fp, seg);
        const page = takePage(seg, cursor?.f ?? 0, maxBytes);
        if (page.returnedBytes > deps.cfg.previewMaxBytes)
          throw mcpError("preview-cue-too-large", `${seg.unit === "cue" ? "Cue" : "Line"} ${page.start + 1} alone is ${page.returnedBytes} UTF-8 bytes, more than SUBTITLE_MCP_PREVIEW_MAX_BYTES (${deps.cfg.previewMaxBytes}), the largest page this server returns; pages never split a ${seg.unit}, so the text from here on can't be previewed.`,
            // The file is already stored (preview_text only reads stored files): point at it, don't suggest converting.
            `The operator can raise SUBTITLE_MCP_PREVIEW_MAX_BYTES (up to ${PREVIEW_HARD_CEILING_BYTES}) and restart the MCP server, or read the stored file directly at ${location}.`,
            { limit: { name: "SUBTITLE_MCP_PREVIEW_MAX_BYTES", value: deps.cfg.previewMaxBytes, actual: page.returnedBytes }, location });
        const total = seg.parts.length, n = page.end - page.start;
        const U = seg.unit === "cue" ? "Cue" : "Line";
        const pos = total === 0 ? { [`returned${U}s`]: 0, [`total${U}s`]: 0 } : { [`from${U}`]: page.start + 1, [`to${U}`]: page.end, [`returned${U}s`]: n, [`total${U}s`]: total };
        const structured: any = {
          source: src.source, ...(byJob ? { jobId: a.jobId, which: a.which } : {}), fileName, mediaType, bytes, location, ...(formatId ? { format: formatId } : {}),
          text: page.text, unit: seg.unit, maxBytes, truncated: page.more,
          ...(page.more ? { next: encodeCursor({ k: key, h: fp, u: seg.unit, f: page.end, m: maxBytes }) } : {}),
          returnedBytes: page.returnedBytes, totalBytes: seg.totalBytes, ...pos,
          ...(convertedFrom ? { convertedFrom, convertedTo: "srt" } : {}), warnings: [...clampWarning, ...warnings], ...(requestId ? { requestId } : {}),
        };
        return { structured, logFields: { unit: seg.unit, pageBytes: page.returnedBytes, paged: Boolean(cursor) || page.more } };
      } catch (e) {
        if (e instanceof ToolFailure && byJob) { e.toolError.jobId = a.jobId; e.toolError.jobUrl = jobPath; explainNotStored(e, a.jobId); }
        throw e;
      }
    },
  });
}

interface Loaded {
  source: "job" | "local" | "remote";
  /** The stored bytes; absent when the change check found the cached entry still current. */
  data?: Buffer; cached?: PreviewEntry; version?: string;
  fileName: string; mediaType: string; location: string;
  formatId?: string; known?: any; key: string; requestId?: string; profile?: any; detected?: any;
}

/** After a full read: the cached entry for the same bytes (an API without ETags, or a touched but unchanged file). */
function sameContent(deps: Deps, key: string, fp: string, version: string | undefined): PreviewEntry | undefined {
  const e = deps.previewCache.peek(key);
  if (!e || e.fp !== fp) return undefined;
  deps.previewCache.hitByContent();
  if (version !== undefined && e.version !== version) deps.previewCache.set({ ...e, version });
  return e;
}

/** Conditional GET of an API file (H7): If-None-Match with the cached ETag; 304 means the cached entry is current. */
async function conditionalGet(deps: Deps, call: Call, key: string, req: { path: string; query?: Record<string, string | undefined> }) {
  const prev = deps.previewCache.peek(key);
  const headers: Record<string, string> = prev?.version ? { "If-None-Match": prev.version } : {};
  const response = await deps.api.request({ method: "GET", path: req.path, query: req.query, kind: "conversion", accept: "application/octet-stream", responseBytes: true, headers, passStatuses: [304] }, { ...call, requestId: withSuffix(call.requestId, ".f") });
  const etag = response.headers.get("etag") ?? undefined;
  if (response.status === 304) {
    const cached = deps.previewCache.get(key, etag ?? prev?.version);
    if (cached) return { cached, response, etag };
    // Evicted meanwhile: read it again without the condition.
    const again = await deps.api.request({ method: "GET", path: req.path, query: req.query, kind: "conversion", accept: "application/octet-stream", responseBytes: true }, { ...call, requestId: withSuffix(call.requestId, ".f2") });
    return { response: again, etag: again.headers.get("etag") ?? undefined };
  }
  if (prev) deps.previewCache.get(key, etag); // counts the miss and drops a stale version
  return { response, etag };
}

async function loadJobFile(deps: Deps, call: Call, caps: Caps, jobId: string, which: "input" | "output", variant = ""): Promise<Loaded> {
  const jobPath = `/v1/jobs/${jobId}`;
  call.log.source = "job";
  const meta = await deps.api.request({ method: "GET", path: jobPath, kind: "metadata" }, call);
  const job: any = meta.json;
  if (job?.id !== jobId) throw mcpError("api-protocol-error", "The job metadata id does not match the requested id.");
  // Each distinct request gets its own correlation id: base id for the job metadata, `.f` for the file.
  const key = hashKey(`job:${jobId}:${which}${variant}`);
  const { response, cached, etag } = await conditionalGet(deps, call, key, { path: `${jobPath}/${which}` });
  const data = cached ? undefined : response.bytes;
  if (!cached && !data) throw mcpError("api-protocol-error", "The job file response contains no byte body.");
  const cap = inputCap(caps);
  if (data && data.length > cap.value) throw tooLarge("The job file", cap, data.length);
  const rawLocation = job?.[which];
  if (typeof rawLocation !== "string") throw mcpError("api-protocol-error", "The job has no location metadata for its downloaded file.");
  const location = redactedLocation(rawLocation);
  const known = which === "input" ? job.result?.detected : job.result?.outputs?.[0];
  return {
    source: "job", data, cached, version: etag, location,
    fileName: sanitizeOutputName(locationBaseName(location) || `${jobId}-${which}`),
    mediaType: (response.contentType || "application/octet-stream").split(";")[0].trim(),
    formatId: str(which === "input" ? known?.id : known?.formatId), known,
    key, requestId: response.requestId, profile: job.result?.profile, detected: job.result?.detected,
  };
}

/** preview_text {location}: a local file in this server's allowed folders, or an API file/s3 location read through GET /v1/storage/file. */
async function loadLocation(deps: Deps, call: Call, caps: Caps, location: string, variant = ""): Promise<Loaded> {
  const cap = inputCap(caps);
  if (!isRemote(location)) {
    call.log.source = "path";
    call.log.inputHash = deps.log.p(location);
    if (!deps.pathsInSchema) throw mcpError("paths-disabled", "Local files are not available on this server.", "Pass an API location (file:// or s3:// URI from list_files), or a jobId with which.");
    const r = await deps.guard.resolveInputFile(location, (name) => deps.extensions.check(name, "read", call));
    const fileName = sanitizeOutputName(path.basename(location));
    const key = hashKey(`loc:local:${r.real}${variant}`);
    // H7 change check: device, inode, size and modification time from the guard's no-follow lstat; nothing is opened on a hit.
    const version = `fs:${r.dev}:${r.ino}:${r.size}:${r.mtimeMs}`;
    if (r.size > cap.value) throw tooLarge(location, cap, r.size);
    const cached = deps.previewCache.get(key, version);
    if (cached) return { source: "local", cached, version, fileName, mediaType: mediaTypeOf(fileName), location, key };
    const data = await readFileChecked(r.real, location, cap);
    return { source: "local", data, version, fileName, mediaType: mediaTypeOf(fileName), location, key };
  }
  const shown = redactInput(location);
  call.log.source = inputScheme(location);
  call.log.inputHash = deps.log.p(shown);
  const rs = await remoteState(deps, call);
  if (rs.state !== "on") throw remoteUnavailable(rs, "Reading an API location");
  const key = hashKey(`loc:remote:${location}${variant}`);
  const { response, cached, etag } = await conditionalGet(deps, call, key, { path: "/v1/storage/file", query: { location } })
    .catch((e) => { throw staleGate(deps, e); });
  const data = cached ? undefined : response.bytes;
  if (!cached && !data) throw mcpError("api-protocol-error", "The storage file response contains no byte body.");
  if (data && data.length > cap.value) throw tooLarge("The file", cap, data.length);
  const fileName = sanitizeOutputName(locationBaseName(shown) || "file");
  return { source: "remote", data, cached, version: etag, fileName, mediaType: (response.contentType || mediaTypeOf(fileName)).split(";")[0].trim(), location: shown, key, requestId: response.requestId };
}

function mediaTypeOf(name: string): string {
  const ext = /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase();
  return ext === "srt" ? "application/x-subrip" : ext === "vtt" ? "text/vtt" : "application/octet-stream";
}

/** Plain wording for the API's 409 job-*-not-stored, naming the inline (attached) case, which is the usual cause. */
function explainNotStored(e: ToolFailure, jobId: string): void {
  const te = e.toolError;
  if (te.source !== "api") return;
  if (te.code === "job-output-not-stored") {
    te.title = "Job output not stored";
    te.detail = `Job ${jobId} has no stored output to preview. It was converted without an API \`output\` location, so the converted file was returned in the convert_subtitle result (attached as an embedded resource) and not stored anywhere; or the conversion did not succeed.`;
    te.hint = `If you have the attached file, save it to disk and read it locally. To preview the result with preview_text, convert again with an API \`output\` location, then call preview_text with the new jobId and which "output".`;
  } else if (te.code === "job-input-not-stored") {
    te.title = "Job input not stored";
    te.detail = `Job ${jobId} has no stored input to preview: its source was sent inline (\`content\` or a local \`path\`), not read from an API \`input\` location.`;
    te.hint = "Read the original local file instead, or convert from an API `input` location to make the source previewable.";
  }
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** Text as stored, or undefined when the file is binary or can't be decoded exactly (never a lossy decode). */
function decodeText(data: Buffer, known: any): string | undefined {
  if (known?.kind === "binary") return undefined;
  const encoding = typeof known?.encoding === "string" ? known.encoding.toLowerCase() : undefined;
  let label: string | undefined;
  // Nothing recorded (a file read by location): a UTF-16 byte order mark says so; anything else is tried as UTF-8.
  if (known === undefined && data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) label = "utf-16le";
  else if (known === undefined && data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) label = "utf-16be";
  else if (encoding === undefined || /^utf-8(?:-|$)/.test(encoding)) label = "utf-8";
  else if (encoding.startsWith("utf-16")) label = encoding.includes("be") ? "utf-16be" : "utf-16le";
  else if (known?.kind === "text") label = encoding;
  if (!label) return undefined;
  // Unknown kind: NUL bytes mean binary even when the bytes happen to be valid UTF-8.
  if (known?.kind !== "text" && label === "utf-8" && data.includes(0)) return undefined;
  if (label.startsWith("utf-16") && data.length % 2 !== 0) return undefined;
  try { return new TextDecoder(label, { fatal: true }).decode(data); } catch { return undefined; }
}

/** Converts a binary stored file to SRT through the API, inline only: no output location, nothing is written. */
async function convertToSrt(deps: Deps, call: Call, caps: Caps, f: { data: Buffer; fileName: string; formatId?: string; location: string; which: string; profile?: any; detected?: any; fps?: number; local?: boolean }) {
  const profile: Record<string, any> = { encoding: { output: "utf-8-no-bom" } };
  if (f.formatId) profile.source = { format: f.formatId };
  // Formats such as PAC record no frame rate: use the one given, else the rate the job read (input) or wrote (output) the file at.
  const fps = f.fps ?? jobFrameRate(f.profile, f.detected, f.which);
  if (fps !== undefined) profile.source = { ...profile.source, fps };
  // PAC has no code page in the file; reuse the one the job wrote (output) or was told to read (input).
  const pac = f.profile?.formatOptions?.pac;
  const cp = f.which === "output" ? pac?.codePage : pac?.inputCodePage;
  if (f.formatId === "pacscreenelectronics" && (typeof cp === "string" || typeof cp === "number") && cp !== "auto") profile.formatOptions = { pac: { inputCodePage: cp } };
  const json = JSON.stringify({ content: f.data.toString("base64"), contentEncoding: "base64", fileName: f.fileName, target: "srt", profile });
  const n = Buffer.byteLength(json);
  if (n > caps.jsonBody) throw tooLarge("The SRT conversion request for this binary file", { name: "maxRequestBodyBytes.json", value: caps.jsonBody }, n);
  const started = Date.now();
  const srtCall = { ...call, requestId: withSuffix(call.requestId, ".s") };
  let res;
  try {
    res = await deps.api.request({ method: "POST", path: "/v1/convert/json", kind: "conversion", headers: { Prefer: `wait=${Math.max(0, Math.min(caps.requestMaxWaitSeconds ?? 60, Math.floor(deps.cfg.timeoutMs / 1000)))}` }, raw: { body: json, contentType: "application/json" } }, srtCall);
    res = await finishConversion(deps.api, res, srtCall, deps.cfg, started);
  } catch (e) {
    if (e instanceof ToolFailure && e.toolError.source === "api" && e.toolError.code === "frame-rate-required") {
      e.toolError.hint = `${f.formatId ?? "This format"} records no frame rate, and ${f.fps === undefined ? "none is known for this file" : "the given one was not used"}. Call preview_text again with \`fps\` set to the rate the file was made at (25 for PAL/European broadcast, 29.97 for NTSC, 23.976 or 24 for film); ask the user if the context doesn't say. Cue times in the SRT view depend on it; the text doesn't.`;
      e.toolError.errors = [{ pointer: "/fps", message: "Required to show this file's cue times." }];
    } else if (e instanceof ToolFailure && e.toolError.source === "api" && e.toolError.status === 422) {
      const how = `preview_text converts binary files to SRT to show their text and takes no profile settings. To read it with a setting from this hint, call convert_subtitle with ${f.local ? "path" : "input"} "${f.location}", target "srt" and that profile setting, and no output (nothing is written).`;
      e.toolError.hint = e.toolError.hint ? `${e.toolError.hint} ${how}` : how;
    }
    throw e;
  }
  const r: any = res.json ?? {};
  const o = Array.isArray(r.outputs) ? r.outputs[0] : undefined;
  if (typeof o?.content !== "string") throw mcpError("api-protocol-error", "The SRT conversion of the binary job file returned no content.", "Report this with the requestId.", { requestId: res.requestId });
  const text = (o.contentEncoding === "base64" ? Buffer.from(o.content, "base64").toString("utf8") : o.content).replace(/^\uFEFF/, "");
  return { text, warnings: mapWarnings(r.warnings), formatId: str(r.detected?.id), requestId: res.requestId };
}

/** The frame rate a job read its input at (source.fps) or wrote its output at (target.fps, else the source's rate). */
function jobFrameRate(profile: any, detected: any, which: string): number | undefined {
  const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined);
  const source = n(profile?.source?.fps) ?? n(detected?.formatDetails?.frameRate);
  return which === "output" ? n(profile?.target?.fps) ?? source : n(profile?.source?.fps);
}

function redactedLocation(value: string): string {
  if (value.startsWith("/")) return pathToFileURL(value).href;
  try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.href; }
  catch { throw mcpError("api-protocol-error", "The API returned an invalid stored location."); }
}
