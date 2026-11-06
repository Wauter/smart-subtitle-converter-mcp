import { z } from "zod";
import { pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { Deps } from "../context.js";
import { ToolFailure, mcpError } from "../errors.js";
import { defineTool, getCaps, inputCap, tooLarge } from "./common.js";
import { sanitizeOutputName } from "../fs/write.js";

export function registerJobFileTool(server: McpServer, deps: Deps): void {
  defineTool(server, deps, {
    name: "get_job_file", title: "Get job file",
    description: "Fetch the current stored input or single subtitle output after a storage-to-storage convert_subtitle when you need the files, for example to inspect the result alongside its warnings. Give only jobId and which: input | output. This re-reads storage, not a cached archive; files may change or disappear. Local MCP path uploads/inline content have no stored input, and an omitted API output has no stored output: use the original local file or conversion result. No sidecar/both, saveTo, outputPath or arbitrary URI. Any valid API key knowing the unguessable job id can fetch it. Query-redacted HTTPS locations cannot be replayed. Does not re-run detection or conversion.",
    shape: { jobId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), which: z.enum(["input", "output"]) },
    output: {
      jobId: z.string(), which: z.enum(["input", "output"]), fileName: z.string(), mediaType: z.string(),
      bytes: z.number().int(), location: z.string(), contentEncoding: z.enum(["text", "base64"]),
      inline: z.enum(["text", "resource"]), resourceUri: z.string().optional(),
      requestId: z.string().optional(),
    },
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
        const pathname = location.startsWith("/") ? location : new URL(location).pathname;
        let fileName = pathname.split("/").pop() || `${a.jobId}-${a.which}`;
        try { fileName = decodeURIComponent(fileName); } catch { /* preserve escaped name */ }
        fileName = sanitizeOutputName(fileName);
        const mediaType = (response.contentType || "application/octet-stream").split(";")[0].trim();
        const known = a.which === "input" ? job.result?.detected : job.result?.outputs?.[0];
        const encoding = typeof known?.encoding === "string" ? known.encoding.toLowerCase() : undefined;
        let text: string | undefined;
        if (known?.kind !== "binary" && typeof encoding === "string" && /^utf-(8|16)(?:-|$)/i.test(encoding)) {
          try { text = new TextDecoder(encoding.startsWith("utf-16") ? (encoding.includes("be") ? "utf-16be" : "utf-16le") : "utf-8", { fatal: true }).decode(data); } catch { /* binary fallback, never a lossy decode */ }
        }
        const contentEncoding = text === undefined ? "base64" as const : "text" as const;
        const content = text ?? data.toString("base64");
        const structured: any = { jobId: a.jobId, which: a.which, fileName, mediaType, bytes: data.length, location, contentEncoding, ...(response.requestId ? { requestId: response.requestId } : {}) };
        const blocks: ContentBlock[] = [];
        if (text !== undefined && data.length <= deps.cfg.inlineTextMaxBytes) {
          structured.inline = "text";
          blocks.push({ type: "text", text });
        } else {
          const uri = `subtitleedit://outputs/${encodeURIComponent(response.requestId ?? call.requestId)}/${encodeURIComponent(fileName)}`;
          structured.inline = "resource"; structured.resourceUri = uri;
          blocks.push({ type: "resource", resource: text === undefined ? { uri, mimeType: mediaType, blob: content } : { uri, mimeType: mediaType, text } });
        }
        return { structured, summary: `Read ${a.which} for job ${a.jobId}: ${fileName}, ${data.length} bytes (${mediaType}). Current storage contents, not an archived copy.`, blocks };
      } catch (e) {
        if (e instanceof ToolFailure) { e.toolError.jobId = a.jobId; e.toolError.jobUrl = jobPath; }
        throw e;
      }
    },
  });
}

function redactedLocation(value: string): string {
  if (value.startsWith("/")) return pathToFileURL(value).href;
  try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.href; }
  catch { throw mcpError("api-protocol-error", "The API returned an invalid stored location."); }
}
