import { z } from "zod";
import { pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Call, Deps } from "../context.js";
import { ToolFailure, mcpError, type WarningT } from "../errors.js";
import { defineTool, getCaps, inputCap, mapWarnings, tooLarge, Warning, warningText } from "./common.js";
import { sanitizeOutputName } from "../fs/write.js";
import { finishConversion } from "../api/jobs.js";
import type { Caps } from "../api/limits.js";
import { checkCursor, clampPageBytes, decodeCursor, encodeCursor, fingerprint, hashKey, locationBaseName, pageText, PREVIEW_MIN_BYTES, segment, stripBom, takePage } from "./textPage.js";

export function describePreviewText(deps: Deps): string {
  const c = deps.cfg;
  return "Read the subtitle text of a convert_subtitle job's stored input or output, to check spelling, language and timing. This is a read-only text preview for you, not the file: it never returns bytes to save. Give `jobId` and `which` (input | output); files are reachable only by job id, never by URI." +
    " Text formats are returned as stored. Binary formats (EBU STL, PAC, Cavena 890, …) are converted to SRT for reading: `convertedFrom` is the stored format id, `convertedTo` is 'srt', and `warnings` say what the SRT view lost or changed; the stored file is never modified." +
    ` The text is paged and the result's \`text\` holds one page. SRT and WebVTT pages always end on a whole cue, other text on a whole line. \`maxBytes\` sets the page size in UTF-8 bytes (default ${c.previewDefaultBytes}, clamped to ${PREVIEW_MIN_BYTES}..${c.previewMaxBytes}); only a single cue larger than maxBytes is returned alone over it.` +
    " When `truncated` is true, more text follows: call again with the same jobId and which and `cursor` set to `next` (you may change maxBytes between pages). `fromCue`/`toCue` (or `fromLine`/`toLine`), `totalCues` (or `totalLines`), `returnedBytes` and `totalBytes` say where you are; tell the user when you only read part of a file. If the stored file changes between pages the call fails with `preview-source-changed`: start again without cursor." +
    " Each call re-reads current storage (not a cached copy); files may change or disappear. Local path uploads and inline content have no stored input, and a conversion without an API `output` has no stored output. Any valid API key knowing the unguessable job id can read it. Query-redacted HTTPS locations cannot be replayed.";
}

const count = z.number().int().nonnegative();

export const PreviewTextOutput = {
  jobId: z.string().describe("The job id the file belongs to"),
  which: z.enum(["input", "output"]).describe("Which of the job's stored files was read"),
  fileName: z.string().describe("Name of the stored file (last segment of its location)"),
  mediaType: z.string().describe("Media type the API reported for the stored file"),
  bytes: count.describe("Size of the stored file in bytes (before any SRT conversion)"),
  location: z.string().describe("The stored file's location, with any credentials or query removed"),
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
  warnings: z.array(Warning).describe("Warnings from the SRT conversion of a binary file (what the SRT view lost), else empty"),
  requestId: z.string().optional().describe("API request id of the last API call, for support"),
};

export function registerPreviewTextTool(server: McpServer, deps: Deps): void {
  defineTool(server, deps, {
    name: "preview_text", title: "Preview subtitle text", warningArray: true,
    description: describePreviewText(deps),
    shape: {
      jobId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).describe("Job id (`jobId`) returned by convert_subtitle"),
      which: z.enum(["input", "output"]).describe("input | output: the job's stored source or its stored result"),
      maxBytes: z.number().int().positive().optional().describe(`Page size in UTF-8 bytes (default ${deps.cfg.previewDefaultBytes}, clamped to ${PREVIEW_MIN_BYTES}..${deps.cfg.previewMaxBytes})`),
      cursor: z.string().max(512).regex(/^[A-Za-z0-9_-]+$/).optional().describe("`next` from the previous page, unchanged, to read the following page; omit for the first page"),
    },
    output: PreviewTextOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: async (a, call) => {
      const jobPath = `/v1/jobs/${a.jobId}`;
      try {
        // Decode first: a malformed cursor fails before any API call.
        const cursor = a.cursor !== undefined ? decodeCursor(a.cursor) : undefined;
        const maxBytes = clampPageBytes(a.maxBytes, deps.cfg.previewDefaultBytes, deps.cfg.previewMaxBytes);
        const caps = await getCaps(deps, call);
        const meta = await deps.api.request({ method: "GET", path: jobPath, kind: "metadata" }, call);
        const job: any = meta.json;
        if (job?.id !== a.jobId) throw mcpError("api-protocol-error", "The job metadata id does not match the requested id.");
        const response = await deps.api.request({ method: "GET", path: `${jobPath}/${a.which}`, kind: "conversion", accept: "application/octet-stream", responseBytes: true }, call);
        const data = response.bytes;
        if (!data) throw mcpError("api-protocol-error", "The job file response contains no byte body.");
        const cap = inputCap(caps);
        if (data.length > cap.value) throw tooLarge("The job file", cap, data.length);
        const rawLocation = job?.[a.which];
        if (typeof rawLocation !== "string") throw mcpError("api-protocol-error", "The job has no location metadata for its downloaded file.");
        const location = redactedLocation(rawLocation);
        const fileName = sanitizeOutputName(locationBaseName(location) || `${a.jobId}-${a.which}`);
        const mediaType = (response.contentType || "application/octet-stream").split(";")[0].trim();
        const known = a.which === "input" ? job.result?.detected : job.result?.outputs?.[0];
        const formatId = str(a.which === "input" ? known?.id : known?.formatId);
        const key = hashKey(`job:${a.jobId}:${a.which}`);
        const fp = fingerprint(data);
        // Checked again after segmenting; failing here first avoids a needless SRT conversion.
        if (cursor && cursor.k === key && cursor.h !== fp)
          throw mcpError("preview-source-changed", "The file changed since the previous page was read, so the cursor no longer points into the same text.", "Call preview_text again without `cursor` to start from the first page.");

        let text = decodeText(data, known);
        let warnings: WarningT[] = [];
        let convertedFrom: string | undefined;
        let requestId = response.requestId;
        if (text === undefined) {
          const c = await convertToSrt(deps, call, caps, { data, fileName, formatId, location, which: a.which, profile: job.result?.profile });
          text = c.text; warnings = c.warnings; convertedFrom = c.formatId ?? formatId ?? "unknown";
          requestId = c.requestId ?? requestId;
        }
        const cueFormat = convertedFrom !== undefined || formatId === "subrip" || formatId === "webvtt" || /\.(srt|vtt)$/i.test(fileName);
        const seg = segment(stripBom(text as string), cueFormat);
        if (cursor) checkCursor(cursor, key, fp, seg);
        const page = takePage(seg, cursor?.f ?? 0, maxBytes);
        if (page.returnedBytes > deps.cfg.previewMaxBytes)
          throw mcpError("preview-cue-too-large", `${seg.unit === "cue" ? "Cue" : "Line"} ${page.start + 1} alone is ${page.returnedBytes} UTF-8 bytes, more than the largest page this server returns (${deps.cfg.previewMaxBytes}).`,
            "This file cannot be previewed past this point. Convert it with convert_subtitle to a file instead, or ask the operator to raise SUBTITLE_MCP_PREVIEW_MAX_BYTES.", { limit: { name: "SUBTITLE_MCP_PREVIEW_MAX_BYTES", value: deps.cfg.previewMaxBytes, actual: page.returnedBytes } });
        const total = seg.parts.length, n = page.end - page.start;
        const U = seg.unit === "cue" ? "Cue" : "Line";
        const pos = total === 0 ? { [`returned${U}s`]: 0, [`total${U}s`]: 0 } : { [`from${U}`]: page.start + 1, [`to${U}`]: page.end, [`returned${U}s`]: n, [`total${U}s`]: total };
        const structured: any = {
          jobId: a.jobId, which: a.which, fileName, mediaType, bytes: data.length, location, ...(formatId ? { format: formatId } : {}),
          text: page.text, unit: seg.unit, maxBytes, truncated: page.more,
          ...(page.more ? { next: encodeCursor({ k: key, h: fp, u: seg.unit, f: page.end }) } : {}),
          returnedBytes: page.returnedBytes, totalBytes: seg.totalBytes, ...pos,
          ...(convertedFrom ? { convertedFrom, convertedTo: "srt" } : {}), warnings, ...(requestId ? { requestId } : {}),
        };
        let summary = `Preview of ${a.which} for job ${a.jobId}: ${fileName}, ${data.length} bytes (${mediaType}).`;
        if (convertedFrom) summary += ` It is a binary ${convertedFrom} file, so its text is shown converted to SRT; the stored file is unchanged.`;
        summary += pageText({ unit: seg.unit, from: page.start + 1, to: page.end, total, returnedBytes: page.returnedBytes, totalBytes: seg.totalBytes, truncated: page.more });
        summary += " The text is in the structured result's `text` field (sent once, not repeated here). Current storage contents, not an archived copy.";
        if (warnings.length) summary += ` ${warnings.length} conversion warning${warnings.length === 1 ? "" : "s"}: ${warnings.map(warningText).join("; ")}`;
        return { structured, summary, logFields: { unit: seg.unit, pageBytes: page.returnedBytes, paged: Boolean(cursor) || page.more } };
      } catch (e) {
        if (e instanceof ToolFailure) { e.toolError.jobId = a.jobId; e.toolError.jobUrl = jobPath; }
        throw e;
      }
    },
  });
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** Text as stored, or undefined when the file is binary or can't be decoded exactly (never a lossy decode). */
function decodeText(data: Buffer, known: any): string | undefined {
  if (known?.kind === "binary") return undefined;
  const encoding = typeof known?.encoding === "string" ? known.encoding.toLowerCase() : undefined;
  let label: string | undefined;
  if (encoding === undefined || /^utf-8(?:-|$)/.test(encoding)) label = "utf-8";
  else if (encoding.startsWith("utf-16")) label = encoding.includes("be") ? "utf-16be" : "utf-16le";
  else if (known?.kind === "text") label = encoding;
  if (!label) return undefined;
  // Unknown kind: NUL bytes mean binary even when the bytes happen to be valid UTF-8.
  if (known?.kind !== "text" && label === "utf-8" && data.includes(0)) return undefined;
  try { return new TextDecoder(label, { fatal: true }).decode(data); } catch { return undefined; }
}

/** Converts a binary stored file to SRT through the API, inline only: no output location, nothing is written. */
async function convertToSrt(deps: Deps, call: Call, caps: Caps, f: { data: Buffer; fileName: string; formatId?: string; location: string; which: string; profile?: any }) {
  const profile: Record<string, any> = { encoding: { output: "utf-8-no-bom" } };
  if (f.formatId) profile.source = { format: f.formatId };
  // PAC has no code page in the file; reuse the one the job wrote (output) or was told to read (input).
  const pac = f.profile?.formatOptions?.pac;
  const cp = f.which === "output" ? pac?.codePage : pac?.inputCodePage;
  if (f.formatId === "pacscreenelectronics" && (typeof cp === "string" || typeof cp === "number") && cp !== "auto") profile.formatOptions = { pac: { inputCodePage: cp } };
  const json = JSON.stringify({ content: f.data.toString("base64"), contentEncoding: "base64", fileName: f.fileName, target: "srt", profile });
  const n = Buffer.byteLength(json);
  if (n > caps.jsonBody) throw tooLarge("The SRT conversion request for this binary file", { name: "maxRequestBodyBytes.json", value: caps.jsonBody }, n);
  const started = Date.now();
  let res;
  try {
    res = await deps.api.request({ method: "POST", path: "/v1/convert/json", kind: "conversion", headers: { Prefer: `wait=${Math.max(0, Math.min(caps.requestMaxWaitSeconds ?? 60, Math.floor(deps.cfg.timeoutMs / 1000)))}` }, raw: { body: json, contentType: "application/json" } }, call);
    res = await finishConversion(deps.api, res, call, deps.cfg, started);
  } catch (e) {
    if (e instanceof ToolFailure && e.toolError.source === "api" && e.toolError.status === 422) {
      const how = `preview_text converts binary files to SRT to show their text and takes no profile settings. To read it with a setting from this hint, call convert_subtitle with input "${f.location}", target "srt" and that profile setting, and no output (nothing is written).`;
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

function redactedLocation(value: string): string {
  if (value.startsWith("/")) return pathToFileURL(value).href;
  try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.href; }
  catch { throw mcpError("api-protocol-error", "The API returned an invalid stored location."); }
}
