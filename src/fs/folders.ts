import type { Root, RootsSnapshot } from "./guard.js";
import { isHiddenPath } from "./hidden.js";

export const CONFIGURE =
  "set SUBTITLE_MCP_ALLOWED_DIRS (read-write folders) and/or SUBTITLE_MCP_READONLY_DIRS (read-only folders) in this MCP server's configuration";

/** Hidden allowed folders (see hidden.ts) are never named: nothing in them can be read or listed. */
const visible = (roots: Root[]) => roots.filter((r) => !isHiddenPath(r.path));
const hiddenNote = (roots: Root[]) => {
  const n = roots.length - visible(roots).length;
  return n ? ` ${n} more allowed folder${n === 1 ? " is" : "s are"} hidden (a path component starts with '.'), so not shown: nothing there is read, listed or written.` : "";
};
const list = (roots: Root[]) => visible(roots).map((r) => `${r.path} (${r.writable ? "read-write" : "read-only"})`).join(", ");

/**
 * The one sentence every path-taking tool description (and path-not-allowed hints) use to name the allowed
 * folders, e.g. "Allowed folders: /a (read-write), /b (read-only)." Built from the roots in effect right now.
 */
export function allowedFoldersText(s: RootsSnapshot): string {
  if (s.roots.length)
    return `Allowed folders: ${list(s.roots) || "none readable"}.` + hiddenNote(s.roots) + (s.pending ? " More may follow from your MCP client's workspace roots (not received yet)." : "");
  if (s.pending)
    return `Allowed folders: none yet. This server uses the folders your MCP client shares (workspace roots) and hasn't received any; if none arrive, file paths stay disabled, so ask the user to ${CONFIGURE}. Until then, pass inline content.`;
  return `Allowed folders: none, so file paths are disabled${s.reason ? ` (${s.reason})` : ""}. Ask the user to ${CONFIGURE}. Until then, pass inline content.`;
}

/**
 * Server instructions (sent once, in the initialize result). When client roots can still arrive (they always come
 * after notifications/initialized), the instructions never claim there are none; they point at the live sources.
 */
export function instructionsFoldersText(s: RootsSnapshot): string {
  if (s.client === undefined) return allowedFoldersText(s);
  const configured = s.roots.filter((r) => r.source !== "client");
  return (
    "Allowed folders come from this server's configuration (SUBTITLE_MCP_ALLOWED_DIRS read-write, SUBTITLE_MCP_READONLY_DIRS read-only) and/or your MCP client's workspace roots" +
    (visible(configured).length ? `; configured: ${list(configured)}` : "") +
    ". The current list is in each path tool's description and in list_allowed_folders; only if those show none, ask the user to " +
    CONFIGURE +
    "."
  );
}

export type FoldersState = "ready" | "waiting-for-roots" | "roots-unsupported" | "roots-empty" | "roots-failed" | "none";

/** list_allowed_folders result, from the same snapshot as the descriptions. */
export function foldersReport(s: RootsSnapshot) {
  let state: FoldersState;
  if (s.pending) state = "waiting-for-roots";
  else if (s.roots.length) state = "ready";
  else if (s.client === "unsupported") state = "roots-unsupported";
  else if (s.client === "empty") state = "roots-empty";
  else if (s.client === "failed") state = "roots-failed";
  else state = "none";
  const hiddenFolders = s.roots.length - visible(s.roots).length;
  const folders = visible(s.roots).map((r) => ({ path: r.path, mode: r.writable ? ("read-write" as const) : ("read-only" as const), source: r.source === "client" ? ("client-roots" as const) : ("config" as const) }));
  const hint =
    state === "ready"
      ? undefined
      : state === "waiting-for-roots"
        ? "The client's workspace roots haven't arrived yet; call list_allowed_folders again shortly. If none arrive, ask the user to " + CONFIGURE + "."
        : "Ask the user to " + CONFIGURE + ". Until then, pass inline content.";
  return {
    state,
    folders,
    clientRoots: s.client ?? ("not-used" as const),
    ...(hiddenFolders ? { hiddenFolders } : {}),
    ...(s.roots.length === 0 && s.reason ? { reason: s.reason } : {}),
    ...(hint ? { hint } : {}),
    summary: allowedFoldersText(s),
  };
}
