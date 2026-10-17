import type { RootsSnapshot } from "./guard.js";

const CONFIGURE =
  "set SUBTITLE_MCP_ALLOWED_DIRS (read-write folders) and/or SUBTITLE_MCP_READONLY_DIRS (read-only folders) in this MCP server's configuration";

/**
 * The one sentence every path-taking tool description (and the server instructions) uses to name the allowed
 * folders, e.g. "Allowed folders: /a (read-write), /b (read-only)." Built from the roots in effect right now.
 */
export function allowedFoldersText(s: RootsSnapshot): string {
  if (s.roots.length) return `Allowed folders: ${s.roots.map((r) => `${r.path} (${r.writable ? "read-write" : "read-only"})`).join(", ")}.`;
  if (s.pending)
    return `Allowed folders: none yet. This server uses the folders your MCP client shares (workspace roots) and hasn't received any; if none arrive, file paths stay disabled, so ask the user to ${CONFIGURE}. Until then, pass inline content.`;
  return `Allowed folders: none, so file paths are disabled${s.reason ? ` (${s.reason})` : ""}. Ask the user to ${CONFIGURE}. Until then, pass inline content.`;
}
