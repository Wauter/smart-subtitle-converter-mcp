import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../context.js";
import { foldersReport } from "../fs/folders.js";
import { defineTool } from "./common.js";
import { remoteLocations } from "./storage.js";

const LOCAL_ONLY = "This reports MCP-local folders only, never API STORAGE_FILE_ROOTS, S3 buckets or HTTPS hosts; use the API schemes from limits/descriptions for input/output URIs.";
const WITH_REMOTE = "`folders` are local folders of this MCP server (plain paths, for `path`/`outputPath` and list_files/preview_text). `remote` reports the converter API's storage locations (file:// and s3:// URIs on the API's side, for list_files, preview_text {location} and convert `input`/`output`); its `state` is on, disabled-api (the API has browsing off: STORAGE_LIST_ENABLED) or unknown. HTTPS hosts are listed as not listable. Local and API file paths are different machines' paths: never mix them.";

/** list_allowed_folders: the folders in effect now, from the same snapshot the tool descriptions are built from, plus API locations when browsing is on. */
export function registerFoldersTool(server: McpServer, deps: Deps): void {
  const listing = deps.cfg.listEnabled;
  defineTool(server, deps, {
    name: "list_allowed_folders",
    title: "List allowed folders",
    description:
      "List the folders this server may read and write right now, each with its mode (read-write or read-only) and source (`config`: SUBTITLE_MCP_ALLOWED_DIRS / SUBTITLE_MCP_READONLY_DIRS; `client-roots`: your MCP client's workspace roots). `state` says whether client roots are still expected (`waiting-for-roots`), unsupported or empty; when no folders are available, `hint` says what the user should configure. Use it before working with local paths, or when a path is refused. " +
      (listing ? WITH_REMOTE : LOCAL_ONLY),
    shape: {},
    output: {
      state: z.enum(["ready", "waiting-for-roots", "roots-unsupported", "roots-empty", "roots-failed", "none"]),
      folders: z.array(z.object({ path: z.string(), mode: z.enum(["read-write", "read-only"]), source: z.enum(["config", "client-roots"]) })),
      clientRoots: z.enum(["waiting", "received", "empty", "failed", "unsupported", "disabled", "not-used"]),
      hiddenFolders: z.number().int().positive().optional().describe("How many allowed folders are hidden (a path component starts with '.') and so not listed here: files there can be written but never read or listed"),
      reason: z.string().optional(),
      hint: z.string().optional(),
      ...(listing ? {
        remote: z.object({
          state: z.enum(["on", "disabled-api", "unknown"]).describe("on: API locations below; disabled-api: the API has browsing off; unknown: API unreachable"),
          locations: z.array(z.object({
            location: z.string().describe("API folder URI (file:// or s3://), or an HTTPS host"),
            scheme: z.string(),
            listable: z.boolean().describe("list_files can list it (file, s3; never https)"),
            readable: z.boolean().describe("preview_text {location} can read files in it"),
            prefix: z.string().optional().describe("The allowlist only covers names starting with this prefix inside the folder; pass it to list_files"),
            note: z.string().optional(),
          })),
          hint: z.string().optional(),
        }).describe("The converter API's storage locations (another machine's paths); present when SUBTITLE_MCP_LIST_ENABLED=true"),
      } : {}),
      summary: z.string(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (_a, call) => {
      const r = foldersReport(deps.guard.roots.snapshot());
      const lines = [listing ? `Local (this MCP server): ${r.summary}` : r.summary, `State: ${r.state} (client roots: ${r.clientRoots}).`];
      if (r.hint) lines.push(r.hint);
      if (!listing) return { structured: r, summary: lines.join("\n") };
      const remote = await remoteLocations(deps, call);
      if (remote.state === "on") {
        lines.push(remote.locations.length
          ? `API locations (on the converter API's side): ${remote.locations.map((l) => `${l.location}${l.prefix ? ` (prefix ${l.prefix})` : ""}${l.listable ? "" : " (not listable)"}`).join(", ")}.`
          : "API locations: none configured on the converter API.");
      } else lines.push(`API locations: ${remote.state}. ${remote.hint}`);
      return { structured: { ...r, remote }, summary: lines.join("\n") };
    },
  });
}
