import { z } from "zod";
import { pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Call, Deps } from "../context.js";
import { ToolFailure, mcpError, type WarningT } from "../errors.js";
import { defineTool, getCaps, inputCap, mapWarnings, tooLarge, Warning, warningText } from "./common.js";
import { sanitizeOutputName } from "../fs/write.js";
import { finishConversion } from "../api/jobs.js";
import type { Caps } from "../api/limits.js";
import { locationBaseName, textView, truncationText } from "./textView.js";

export function describeJobFile(deps: Deps): string {
  return "Read the current stored input or output of a storage-to-storage convert_subtitle job, to check its subtitle text (spelling, language, timing). Give jobId and which (input | output); files are reachable only by job id, never by URI." +
    " The file content is returned as text in `text`. Binary formats (EBU STL, PAC, Cavena 890, …) are converted to SRT for reading: `convertedFrom` is the stored format id, `convertedTo` is 'srt', and `warnings` say what the SRT view lost or changed; the stored file is never modified." +
    ` Text over ${deps.cfg.inlineTextMaxBytes} bytes is cut at the last whole cue (SRT) or line: then \`truncated\` is true and \`returnedBytes\`/\`totalBytes\` (and \`returnedCues\`/\`totalCues\` for SRT) say how much was returned; tell the user the view is partial. \`bytes\` is the stored file's size.` +
    " This re-reads storage, not a cached archive; files may change or disappear. Local MCP path uploads/inline content have no stored input, and an omitted API output has no stored output. Any valid API key knowing the unguessable job id can fetch it. Query-redacted HTTPS locations cannot be replayed.";
}

export const JobFileOutput = {
  jobId: z.string(), which: z.enum(["input", "output"]), fileName: z.string(), mediaType: z.string(),
  bytes: z.number().int().describe("Size of the stored file in bytes"),
  location: z.string(),
  format: z.string().optional().describe("Format id of the stored file, when the job recorded it"),
  text: z.string().describe("The file content as text (SRT when convertedFrom is set); may be truncated"),
  truncated: z.boolean().describe("true when `text` was cut at the size limit"),
  returnedBytes: z.number().int().describe("UTF-8 bytes of `text`"),
  totalBytes: z.number().int().describe("UTF-8 bytes of the full text before truncation"),
  returnedCues: z.number().int().optional(), totalCues: z.number().int().optional(),
  convertedFrom: z.string().optional().describe("Set when a binary file was converted for reading: its format id"),
  convertedTo: z.literal("srt").optional(),
  warnings: z.array(Warning),
  requestId: z.string().optional(),
};

export function registerJobFileTool(server: McpServer, deps: Deps): void {
  defineTool(server, deps, {
    name: "get_job_file", title: "Get job file", warningArray: true,
    description: describeJobFile(deps),
    shape: {
      jobId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).describe("Job id (`jobId`) returned by convert_subtitle"),
      which: z.enum(["input", "output"]).describe("input | output: the job's stored source or its stored result"),
    },
    output: JobFileOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: async (a, call) => {
      const jobPath = `/v1/jobs/${a.jobId}`;
      try {
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

        let text = decodeText(data, known);
        let warnings: WarningT[] = [];
        let convertedFrom: string | undefined;
        let requestId = response.requestId;
        if (text === undefined) {
          const c = await convertToSrt(deps, call, caps, { data, fileName, formatId, location, which: a.which, profile: job.result?.profile });
          text = c.text; warnings = c.warnings; convertedFrom = c.formatId ?? formatId ?? "unknown";
          requestId = c.requestId ?? requestId;
        }
        const srt = convertedFrom !== undefined || formatId === "subrip" || /\.srt$/i.test(fileName);
        const view = textView(text as string, deps.cfg.inlineTextMaxBytes, srt);
        const structured: any = {
          jobId: a.jobId, which: a.which, fileName, mediaType, bytes: data.length, location, ...(formatId ? { format: formatId } : {}),
          ...view, ...(convertedFrom ? { convertedFrom, convertedTo: "srt" } : {}), warnings, ...(requestId ? { requestId } : {}),
        };
        let summary = `Read ${a.which} for job ${a.jobId}: ${fileName}, ${data.length} bytes (${mediaType}).`;
        if (convertedFrom) summary += ` It is a binary ${convertedFrom} file, so its text is shown converted to SRT${view.totalCues !== undefined ? ` (${view.totalCues} cues)` : ""}; the stored file is unchanged.`;
        summary += ` The content is in \`text\`. Current storage contents, not an archived copy.${truncationText(view)}`;
        if (warnings.length) summary += ` ${warnings.length} conversion warning${warnings.length === 1 ? "" : "s"}: ${warnings.map(warningText).join("; ")}`;
        return { structured, summary, blocks: [{ type: "text", text: view.text }] };
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
      const how = `get_job_file converts binary files to SRT to show their text and takes no profile settings. To read it with a setting from this hint, call convert_subtitle with input "${f.location}", target "srt" and that profile setting, and no output (nothing is written).`;
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
