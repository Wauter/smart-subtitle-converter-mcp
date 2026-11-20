import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Call, Deps } from "../context.js";
import { mcpError, ToolFailure } from "../errors.js";
import { newStats } from "../api/client.js";
import { withSuffix } from "../ids.js";
import { defineTool, redactInput } from "./common.js";
import { hiddenPathError } from "../fs/guard.js";
import { extOf } from "../fs/extensions.js";

/**
 * Browse and read by location (on unless SUBTITLE_MCP_LIST_ENABLED=false).
 *
 * Local: plain absolute paths inside this MCP server's allowed folders (configured and client roots), listed and read
 * by the MCP itself. Remote: file:// and s3:// URIs inside the converter API's allowlists, listed and read through the
 * API's /v1/storage routes, which the API serves only with STORAGE_LIST_ENABLED=true. The MCP reads that capability
 * from GET /v1/limits (`storage.list`) at startup and caches it like the other limits.
 */

export const LIST_PAGE_SIZE = 200;

export type RemoteState =
  | { state: "on"; schemes: string[] }
  | { state: "disabled-api" }
  | { state: "unknown"; reason: string };

/** The API's listing capability from GET /v1/limits (cached). Only consulted when browsing is on in the MCP. */
export async function remoteState(deps: Deps, call?: Call): Promise<RemoteState> {
  const st = await deps.limits.get({ requestId: withSuffix(call?.requestId ?? "mcp-startup", ".l"), signal: call?.signal, stats: newStats() });
  if (st.kind === "ok") return st.limits.storageList ? { state: "on", schemes: st.limits.listSchemes ?? [] } : { state: "disabled-api" };
  if (st.kind === "unsupported") return { state: "disabled-api" };
  return { state: "unknown", reason: "the converter API could not be reached (GET /v1/limits)" };
}

/** Startup: read the API's listing capability once (GET /v1/limits) and log the effective browse/read setup. Never blocks startup. */
export function discoverListing(deps: Deps): Promise<void> {
  if (!deps.cfg.listEnabled) return Promise.resolve();
  return remoteState(deps).then((r) => {
    const fields = { local: deps.pathsInSchema ? "on" : "off (no local file access)", remote: r.state };
    if (r.state === "on") deps.log.info("browse and read by location: on", { ...fields, remoteSchemes: r.schemes });
    else deps.log.warn(`browse and read by location: local only (remote ${r.state === "disabled-api" ? "off on the API: set STORAGE_LIST_ENABLED=true there" : "unknown: the API was not reachable; checked again on use"})`, fields);
  }, (e) => deps.log.warn("browse and read by location: API capability check failed; checked again on use", { error: (e as Error).message }));
}

export const API_OFF_HINT = "Remote (API) locations are not available: the converter API has browsing off (STORAGE_LIST_ENABLED=false, or an API without /v1/storage). Ask the operator to set STORAGE_LIST_ENABLED=true on the API; this MCP picks it up within SUBTITLE_MCP_LIMITS_TTL_MS or on restart. Local folders still work.";

/** Is this a remote (API) location rather than a local path? */
export function isRemote(location: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(location);
}

export function remoteUnavailable(r: Exclude<RemoteState, { state: "on" }>, what: string): ToolFailure {
  return r.state === "disabled-api"
    ? mcpError("storage-list-disabled", `${what} needs browsing on the converter API, which has it off.`, API_OFF_HINT)
    : mcpError("api-unreachable", `${what} needs the converter API, which could not be reached to check whether browsing is on.`, "Check SUBTITLE_API_URL and that the API is running, then try again. Local folders still work.");
}

/** The API refused with storage-list-disabled although its limits said on (changed since): forget the cached capability and say so. */
export function staleGate(deps: Deps, e: unknown): unknown {
  if (e instanceof ToolFailure && e.toolError.code === "storage-list-disabled") {
    deps.limits.invalidate();
    e.toolError.hint = API_OFF_HINT;
  }
  return e;
}

// ---------- cursor: base64url JSON {v:1, m: local|remote, b: binding of location+prefix, a: last local name | c: API cursor} ----------

const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64url");
export const listBinding = (mode: "local" | "remote", location: string, prefix: string) =>
  createHash("sha256").update(`${mode}\n${location}\n${prefix}`).digest("base64url").slice(0, 16);

function cursorInvalid(why: string): ToolFailure {
  return mcpError("list-cursor-invalid", `\`cursor\` is not valid here: ${why}.`, "Pass `next` from the previous page unchanged, with the same location and prefix, or call list_files again without cursor.");
}

export function encodeListCursor(mode: "local" | "remote", binding: string, value: string): string {
  return b64u(JSON.stringify(mode === "local" ? { v: 1, m: mode, b: binding, a: value } : { v: 1, m: mode, b: binding, c: value }));
}

export function decodeListCursor(cursor: string, mode: "local" | "remote", binding: string): string {
  let o: any;
  if (cursor.length > 0 && cursor.length <= 8192 && /^[A-Za-z0-9_-]+$/.test(cursor)) {
    try { o = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { o = undefined; }
  }
  if (!o || o.v !== 1 || (o.m !== "local" && o.m !== "remote") || typeof o.b !== "string") throw cursorInvalid("it was not returned by list_files");
  if (o.m !== mode || o.b !== binding) throw cursorInvalid("it was returned for another location or prefix");
  const value = mode === "local" ? o.a : o.c;
  if (typeof value !== "string" || !value) throw cursorInvalid("it was not returned by list_files");
  return value;
}

// ---------- local listing ----------

/** H6: per-folder cap on matching entries (visible names with the prefix), and on raw names scanned. Same as the API. */
export const LIST_MAX_ENTRIES = 5000;
export const LIST_MAX_SCAN = 100_000;

function checkPrefix(prefix: string): void {
  if (prefix.length > 1024 || prefix.startsWith("/") || prefix.includes("\\") || prefix.includes("//") || [...prefix].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) || prefix.split("/").slice(0, -1).some((s) => s === "." || s === ".."))
    throw mcpError("invalid-arguments", "`prefix` must be a relative name prefix (at most 1024 characters) without a leading '/', empty or dot segments, backslashes or control characters.", "Pass the start of a file or folder name, e.g. show_ or season1/ep; no globs.");
}

export function folderTooLarge(location: string, prefixed: boolean): ToolFailure {
  return mcpError("folder-too-large", `${location} has more than ${LIST_MAX_ENTRIES} entries${prefixed ? " matching this prefix" : ""}, so it isn't listed.`,
    "Pass a longer `prefix` (the start of the names you want) or list a sub-folder.", { limit: { name: "listMaxEntries", value: LIST_MAX_ENTRIES, actual: LIST_MAX_ENTRIES + 1 } });
}

interface Item { name: string; location: string; type: "file" | "folder"; size?: number; modified?: string }

async function listLocal(deps: Deps, call: Call, location: string, prefix: string, after: string | undefined) {
  const cut = prefix.lastIndexOf("/") + 1;
  const sub = prefix.slice(0, cut), namePrefix = prefix.slice(cut);
  // H2: a name prefix starting with '.' could only match hidden entries.
  if (namePrefix.startsWith(".") || sub.split("/").some((x) => x.startsWith("."))) throw hiddenPathError(prefix);
  const dir = await deps.guard.resolveInputDir(sub ? path.join(location, sub) : location);
  const allowed = await deps.extensions.allowed(call);
  // Stream the folder (no full readdir array), stop early past the caps; sort keys (UTF-8 bytes) computed once per name.
  const matching: { key: Buffer; name: string; kind: "file" | "folder" | "unknown" }[] = [];
  let scanned = 0;
  let handle;
  try { handle = await fs.opendir(dir.real); } catch (e) { throw mcpError("path-not-found", `Couldn't list ${location}${sub} (${(e as NodeJS.ErrnoException).code ?? "error"}).`); }
  try {
    for await (const d of handle) {
      if (++scanned > LIST_MAX_SCAN) throw folderTooLarge(location + sub, prefix.length > 0);
      const name = d.name;
      if (name.startsWith(".") || !name.startsWith(namePrefix)) continue;
      if (d.isSymbolicLink()) continue; // H10: symlinks are never followed (nor shown)
      const kind = d.isDirectory() ? "folder" : d.isFile() ? "file" : d.isFIFO() || d.isSocket() || d.isCharacterDevice() || d.isBlockDevice() ? undefined : "unknown";
      if (!kind) continue;
      if (matching.length >= LIST_MAX_ENTRIES) throw folderTooLarge(location + sub, prefix.length > 0);
      if (kind === "file" && allowed && !allowed.has(extOf(name))) continue; // H3: only subtitle files are listed
      matching.push({ key: Buffer.from(name, "utf8"), name, kind });
    }
  } finally {
    await handle.close().catch(() => {});
  }
  const afterKey = after !== undefined ? Buffer.from(after, "utf8") : undefined;
  const candidates = (afterKey ? matching.filter((m) => Buffer.compare(m.key, afterKey) > 0) : matching).sort((a, b) => Buffer.compare(a.key, b.key));
  const items: Item[] = [];
  for (const c of candidates) {
    const full = path.join(dir.real, c.name);
    let st;
    try { st = await fs.lstat(full); } catch { continue; } // vanished
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) continue;
    if (st.isFile() && allowed && !allowed.has(extOf(c.name))) continue;
    if (items.length === LIST_PAGE_SIZE) return { dir: dir.real, items, more: true };
    items.push(st.isDirectory()
      ? { name: c.name + "/", location: full + path.sep, type: "folder" }
      : { name: c.name, location: full, type: "file", size: st.size, modified: st.mtime.toISOString() });
  }
  return { dir: dir.real, items, more: false };
}

const ItemSchema = z.object({
  name: z.string().describe("Name relative to the listed folder; folders end in '/'"),
  location: z.string().describe("Full URI or absolute path; pass it unchanged as preview_text `location` (files) or list_files `location` (folders)"),
  type: z.enum(["file", "folder"]),
  size: z.number().int().nonnegative().optional().describe("Files: size in bytes"),
  modified: z.string().optional().describe("Files: last modified time (ISO 8601, UTC)"),
});

export function describeListFiles(deps: Deps): string {
  return "List one folder to find subtitle files; pass a file's items[].location unchanged as preview_text `location`. `location` is a local folder of this server (a plain absolute path from list_allowed_folders `folders`) or an API folder (a file:// or s3:// URI from list_allowed_folders `remote.locations`)." +
    ` Lists one level in name order, at most ${LIST_PAGE_SIZE} items a page: subtitle files with size and modified time, and folders (ending in '/'). \`prefix\` keeps names that start with it ('/' descends into a sub-folder, e.g. season1/ep); no globs, no sorting by time, no total count.` +
    " When `truncated` is true, call again with the same `location` and `prefix` and `cursor` set to `next`. Hidden (dot) entries, symlinks and special files are skipped; HTTPS locations can't be listed." +
    (deps.pathsInSchema ? "" : " Local folders are not available on this server.");
}

export function registerListFilesTool(server: McpServer, deps: Deps): void {
  defineTool(server, deps, {
    name: "list_files", title: "List files",
    description: () => describeListFiles(deps),
    shape: {
      location: z.string().min(1).max(4096).describe("Folder: a local absolute path, or an API file:// or s3:// folder URI (from list_allowed_folders)"),
      prefix: z.string().max(1024).optional().describe("Optional name prefix; '/' descends into a sub-folder; no globs"),
      cursor: z.string().optional().describe("`next` from the previous page, unchanged; omit for the first page"),
    },
    output: {
      location: z.string().describe("The listed folder"),
      where: z.enum(["local", "remote"]).describe("local: a folder of this MCP server; remote: an API storage location"),
      prefix: z.string(),
      items: z.array(ItemSchema),
      returned: z.number().int().nonnegative().describe("Items on this page"),
      truncated: z.boolean().describe("true when more items follow; pass `next` as `cursor`"),
      next: z.string().optional().describe("Opaque cursor for the next page; present only when truncated"),
      requestId: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: async (a, call) => {
      const prefix = a.prefix ?? "";
      checkPrefix(prefix);
      const remote = isRemote(a.location);
      const mode = remote ? "remote" : "local";
      const binding = listBinding(mode, a.location, prefix);
      const after = a.cursor !== undefined ? decodeListCursor(a.cursor, mode, binding) : undefined;
      call.log.source = remote ? (a.location.split(":")[0].toLowerCase()) : "path";
      call.log.inputHash = deps.log.p(remote ? redactInput(a.location) : a.location);
      if (!remote) {
        if (!deps.pathsInSchema) throw mcpError("paths-disabled", "Local folders are not available on this server.", "List an API location (file:// or s3:// URI) from list_allowed_folders instead.");
        const r = await listLocal(deps, call, a.location, prefix, after);
        const next = r.more ? encodeListCursor("local", binding, r.items[r.items.length - 1].name.replace(/\/$/, "")) : undefined;
        return result(a.location, "local", prefix, r.items, next);
      }
      const rs = await remoteState(deps, call);
      if (rs.state !== "on") throw remoteUnavailable(rs, "Listing an API location");
      const res = await deps.api.request({ method: "GET", path: "/v1/storage/list", kind: "metadata", query: { location: a.location, prefix: prefix || undefined, cursor: after } }, call).catch((e) => { throw staleGate(deps, e); });
      const j: any = res.json ?? {};
      if (!Array.isArray(j.items)) throw mcpError("api-protocol-error", "The API listing has no items.");
      const items: Item[] = j.items.map((i: any) => ({ name: String(i.name), location: String(i.uri), type: i.type === "folder" ? "folder" : "file",
        ...(typeof i.size === "number" ? { size: i.size } : {}), ...(typeof i.modified === "string" ? { modified: i.modified } : {}) }));
      const next = j.truncated && typeof j.next === "string" ? encodeListCursor("remote", binding, j.next) : undefined;
      return result(typeof j.location === "string" ? j.location : a.location, "remote", prefix, items, next, res.requestId);
    },
  });

  function result(location: string, where: "local" | "remote", prefix: string, items: Item[], next?: string, requestId?: string) {
    return {
      structured: { location, where, prefix, items, returned: items.length, truncated: Boolean(next), ...(next ? { next } : {}), ...(requestId ? { requestId } : {}) },
      logFields: { returned: items.length, truncated: Boolean(next) },
    };
  }
}

/** Remote locations for list_allowed_folders (only when browsing is on in both the MCP and the API). */
export async function remoteLocations(deps: Deps, call: Call) {
  const rs = await remoteState(deps, call);
  if (rs.state === "unknown") return { state: "unknown" as const, locations: [], hint: "The converter API could not be reached to check whether browsing is on; try again shortly. Local folders still work." };
  if (rs.state === "disabled-api") return { state: "disabled-api" as const, locations: [], hint: API_OFF_HINT };
  try {
    const res = await deps.api.request({ method: "GET", path: "/v1/storage/locations", kind: "metadata" }, { ...call, requestId: withSuffix(call.requestId, ".r") });
    const list: any[] = Array.isArray((res.json as any)?.locations) ? (res.json as any).locations : [];
    const locations = list.map((l) => ({ location: redactInput(String(l.uri)), scheme: String(l.scheme), listable: l.listable === true, readable: l.readable === true,
      ...(typeof l.prefix === "string" ? { prefix: l.prefix } : {}), ...(typeof l.note === "string" ? { note: l.note } : {}) }));
    return { state: "on" as const, locations };
  } catch (e) {
    if (e instanceof ToolFailure && e.toolError.code === "storage-list-disabled") { deps.limits.invalidate(); return { state: "disabled-api" as const, locations: [], hint: API_OFF_HINT }; }
    throw e;
  }
}
