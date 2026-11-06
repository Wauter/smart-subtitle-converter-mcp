import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../context.js";
import { foldersReport } from "../fs/folders.js";
import { defineTool } from "./common.js";

/** list_allowed_folders: the folders in effect now, from the same snapshot the tool descriptions are built from. */
export function registerFoldersTool(server: McpServer, deps: Deps): void {
  defineTool(server, deps, {
    name: "list_allowed_folders",
    title: "List allowed folders",
    description:
      "List the folders this server may read and write right now, each with its mode (read-write or read-only) and source (`config`: SUBTITLE_MCP_ALLOWED_DIRS / SUBTITLE_MCP_READONLY_DIRS; `client-roots`: your MCP client's workspace roots). `state` says whether client roots are still expected (`waiting-for-roots`), unsupported or empty; when no folders are available, `hint` says what the user should configure. Use it before working with local paths, or when a path is refused. This reports MCP-local folders only, never API STORAGE_FILE_ROOTS, S3 buckets or HTTPS hosts; use the API schemes from limits/descriptions for input/output URIs.",
    shape: {},
    output: {
      state: z.enum(["ready", "waiting-for-roots", "roots-unsupported", "roots-empty", "roots-failed", "none"]),
      folders: z.array(z.object({ path: z.string(), mode: z.enum(["read-write", "read-only"]), source: z.enum(["config", "client-roots"]) })),
      clientRoots: z.enum(["waiting", "received", "empty", "failed", "unsupported", "disabled", "not-used"]),
      reason: z.string().optional(),
      hint: z.string().optional(),
      summary: z.string(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async () => {
      const r = foldersReport(deps.guard.roots.snapshot());
      const lines = [r.summary, `State: ${r.state} (client roots: ${r.clientRoots}).`];
      if (r.hint) lines.push(r.hint);
      return { structured: r, summary: lines.join("\n") };
    },
  });
}
