import fs from "node:fs/promises";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { mcpError, ToolFailure } from "../errors.js";
import type { Logger } from "../log.js";
import { allowedFoldersText } from "./folders.js";

export interface Root {
  path: string; // realpath
  writable: boolean;
  /** Where the root comes from: SUBTITLE_MCP_ALLOWED_DIRS/READONLY_DIRS ("config") or the client's roots/list. */
  source?: "config" | "client";
}

/** State of the client's workspace roots (local mode). */
export type ClientRootsStatus = "waiting" | "received" | "empty" | "failed" | "unsupported" | "disabled";

export interface RootsSnapshot {
  roots: Root[];
  source: "configured" | "client" | "none";
  /** Why there are no roots (when `roots` is empty). */
  reason?: string;
  /** Client roots are expected but haven't been received yet. */
  pending?: boolean;
  /** Client roots state; undefined when client roots aren't used at all (sidecar, hosted, USE_CLIENT_ROOTS=false). */
  client?: ClientRootsStatus;
}

/** Provides the current roots; `reason` explains why there are none. */
export interface RootsProvider {
  get(): Promise<RootsSnapshot>;
  /** The current state without waiting for an in-flight roots/list (for tool descriptions). */
  snapshot(): RootsSnapshot;
}

export interface GuardOptions {
  /** Path flavour; defaults to the host platform. */
  platform?: NodeJS.Platform;
  caseInsensitive?: boolean;
}

/** Syntax checks (§11.2 step 1). Throws path-not-allowed. */
export function checkPathSyntax(p: unknown, opts: GuardOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  const P = platform === "win32" ? nodePath.win32 : nodePath.posix;
  if (typeof p !== "string" || p.length === 0) throw mcpError("path-not-allowed", "Path must be a non-empty string.");
  if (p.includes("\0")) throw mcpError("path-not-allowed", "Path contains a NUL character.");
  if (p.length > 4096) throw mcpError("path-not-allowed", "Path is longer than 4096 characters.");
  if (platform === "win32") {
    if (/^[\\/]{2}[?.][\\/]/.test(p)) throw mcpError("path-not-allowed", `Device paths are not allowed: ${p}`);
    const driveAbs = /^[A-Za-z]:[\\/]/.test(p);
    const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(p);
    if (!driveAbs && !unc) throw mcpError("path-not-allowed", `Path must be absolute (drive or UNC): ${p}`, "Pass an absolute path inside an allowed folder.");
  } else if (!P.isAbsolute(p)) {
    throw mcpError("path-not-allowed", `Path must be absolute: ${p}`, "Pass an absolute path inside an allowed folder; `~` is not expanded.");
  }
  return P.resolve(p);
}

/** Containment via path.relative (never startsWith). */
export function isInside(root: string, target: string, opts: GuardOptions = {}): boolean {
  const platform = opts.platform ?? process.platform;
  const P = platform === "win32" ? nodePath.win32 : nodePath.posix;
  const ci = opts.caseInsensitive ?? (platform === "win32" || platform === "darwin");
  const r = ci ? root.toLowerCase() : root;
  const t = ci ? target.toLowerCase() : target;
  const rel = P.relative(r, t);
  if (rel === "") return true;
  if (P.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(".." + P.sep);
}

export function findRoot(roots: Root[], real: string, opts: GuardOptions = {}): Root | undefined {
  const hits = roots.filter((r) => isInside(r.path, real, opts));
  // A configured read-only folder is never made writable by a client root that contains it (most restrictive wins).
  const configuredRo = hits.find((r) => !r.writable && r.source !== "client");
  if (configuredRo && !hits.some((r) => r.writable && r.source !== "client")) return configuredRo;
  // Among configured roots, prefer a writable root when nested.
  return hits.find((r) => r.writable) ?? hits[0];
}

function fsErr(e: unknown, callerPath: string, what: "file" | "dir"): ToolFailure {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return mcpError("path-not-found", `Not found: ${callerPath}`);
  if (code === "ENOTDIR") return mcpError("path-not-found", `Not found: ${callerPath}`);
  if (code === "EACCES" || code === "EPERM") return mcpError("permission-denied", `Couldn't access ${callerPath}: permission denied (${code}).`, "The MCP's user (sidecar: the container user) can't access this folder; fix the permissions or choose another folder.", { path: callerPath, osError: { code, ...((e as NodeJS.ErrnoException).syscall ? { syscall: (e as NodeJS.ErrnoException).syscall } : {}), message: "permission denied" } });
  if (code === "EROFS") return mcpError("read-only-filesystem", `Couldn't create ${callerPath}: read-only file system (EROFS).`, "The output volume is mounted read-only; remount it read-write or choose another folder.", { path: callerPath, osError: { code, message: "read-only file system" } });
  if (code === "ENOSPC" || code === "EDQUOT") return mcpError("disk-full", `Couldn't create ${callerPath}: no space left on device (${code}).`, "Free space (or raise the quota) on the output volume, or choose another output folder.", { path: callerPath, osError: { code, message: "no space left on device" } });
  if (code === "ENAMETOOLONG") return mcpError("path-too-long", `Path too long: ${callerPath}`, "Use a shorter output folder or file name.", { path: callerPath, osError: { code, message: "name too long" } });
  if (code === "ELOOP") return mcpError("path-not-allowed", `Symlink loop: ${callerPath}`);
  return mcpError(what === "file" ? "path-not-found" : "not-a-directory", `Cannot access ${callerPath} (${code ?? "error"})`);
}

const STAGING_SEGMENT = ".subtitle-mcp-staging";
function rejectStaging(resolved: string, callerPath: string): void {
  if (resolved.split(/[\\/]/).includes(STAGING_SEGMENT)) {
    throw mcpError("path-not-allowed", `The MCP's staging folder can't be used as an input or output folder: ${callerPath}`, "Choose another folder.");
  }
}

/** D-38: the deepest writable root containing `real` (the output root that holds the staging folder). */
export function outputRootOf(roots: Root[], real: string, opts: GuardOptions = {}): Root | undefined {
  return roots.filter((r) => r.writable && isInside(r.path, real, opts)).sort((a, b) => b.path.length - a.path.length)[0];
}

export class PathGuard {
  constructor(public readonly roots: RootsProvider, private readonly opts: GuardOptions = {}) {}

  /** path-not-allowed whose hint names the allowed folders in effect now. */
  notAllowed(detail: string, advice = "Use a path inside an allowed folder (symlinks must stay inside too)."): ToolFailure {
    return mcpError("path-not-allowed", detail, `${advice} ${allowedFoldersText(this.roots.snapshot())}`);
  }

  /** checkPathSyntax, with the allowed folders added to the hint. */
  private syntax(p: string): string {
    try {
      return checkPathSyntax(p, this.opts);
    } catch (e) {
      if (e instanceof ToolFailure && e.toolError.code === "path-not-allowed") {
        throw this.notAllowed(e.toolError.detail ?? "Path not allowed.", e.toolError.hint ?? "Pass an absolute path inside an allowed folder.");
      }
      throw e;
    }
  }

  private async active(): Promise<Root[]> {
    const r = await this.roots.get();
    if (r.roots.length === 0) {
      throw mcpError(
        "paths-disabled",
        `File paths are disabled: ${r.reason ?? "no allowed folders are configured"}.`,
        "Ask the user to set SUBTITLE_MCP_ALLOWED_DIRS (read-write folders) and/or SUBTITLE_MCP_READONLY_DIRS (read-only folders) in this MCP server's configuration, or use a client that provides workspace roots; or pass inline content. list_allowed_folders shows the current state.",
      );
    }
    return r.roots;
  }

  /** Resolves an input file: realpath inside any root, must be a regular file. */
  async resolveInputFile(p: string): Promise<{ real: string; root: Root; size: number }> {
    const roots = await this.active();
    const resolved = this.syntax(p);
    let real: string;
    try {
      real = await fs.realpath(resolved);
    } catch (e) {
      // Distinguish "outside roots" from "missing" without leaking: only say not found if lexically inside a root.
      if (!findRoot(roots, resolved, this.opts)) throw this.notAllowed(`Path is outside the allowed folders: ${p}`);
      throw fsErr(e, p, "file");
    }
    const root = findRoot(roots, real, this.opts);
    if (!root) throw this.notAllowed(`Path is outside the allowed folders: ${p}`);
    const st = await fs.stat(real).catch((e) => {
      throw fsErr(e, p, "file");
    });
    if (!st.isFile()) throw mcpError("not-a-file", `Not a regular file: ${p}`);
    return { real, root, size: st.size };
  }

  /** Resolves an input directory: realpath inside any root. */
  async resolveInputDir(p: string): Promise<{ real: string; root: Root }> {
    const roots = await this.active();
    const resolved = this.syntax(p);
    rejectStaging(resolved, p);
    let real: string;
    try {
      real = await fs.realpath(resolved);
    } catch (e) {
      if (!findRoot(roots, resolved, this.opts)) throw this.notAllowed(`Path is outside the allowed folders: ${p}`);
      throw fsErr(e, p, "dir");
    }
    const root = findRoot(roots, real, this.opts);
    if (!root) throw this.notAllowed(`Path is outside the allowed folders: ${p}`);
    const st = await fs.stat(real);
    if (!st.isDirectory()) throw mcpError("not-a-directory", `Not a directory: ${p}`);
    return { real, root };
  }

  /** Is a realpath inside an allowed root (used for symlinks found while walking)? */
  /** D-38: output root (deepest writable root) of a realpath'd destination folder. */
  async outputRoot(realDir: string): Promise<string | undefined> {
    const r = await this.roots.get();
    if (!findRoot(r.roots, realDir, this.opts)?.writable) return undefined;
    return outputRootOf(r.roots, realDir, this.opts)?.path;
  }

  async allows(real: string): Promise<boolean> {
    const r = await this.roots.get();
    return !!findRoot(r.roots, real, this.opts);
  }

  /**
   * Resolves an output directory (§11.2 step 4): the deepest existing ancestor is realpath'd and must be in a
   * read-write root; missing directories below it are created when `create` is set.
   */
  async resolveOutputDir(p: string, create: boolean, callerPath = p): Promise<string> {
    const roots = await this.active();
    const resolved = this.syntax(p);
    rejectStaging(resolved, callerPath);
    const P = (this.opts.platform ?? process.platform) === "win32" ? nodePath.win32 : nodePath.posix;
    const missing: string[] = [];
    let cur = resolved;
    let real: string | undefined;
    for (;;) {
      try {
        real = await fs.realpath(cur);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw fsErr(e, callerPath, "dir");
        const parent = P.dirname(cur);
        if (parent === cur) throw mcpError("path-not-found", `Not found: ${callerPath}`);
        missing.unshift(P.basename(cur));
        cur = parent;
      }
    }
    const root = findRoot(roots, real, this.opts);
    if (!root) throw this.notAllowed(`Path is outside the allowed folders: ${callerPath}`);
    if (!root.writable) throw this.notAllowed(`Path is in a read-only folder: ${callerPath}`, "Write to a read-write allowed folder instead.");
    if (missing.length === 0) {
      const st = await fs.stat(real);
      if (!st.isDirectory()) throw mcpError("not-a-directory", `Not a directory: ${callerPath}`);
      return real;
    }
    const target = P.join(real, ...missing);
    if (create) {
      try {
        await fs.mkdir(target, { recursive: true });
      } catch (e) {
        throw fsErr(e, callerPath, "dir");
      }
      // Re-check after creation (a racing symlink could have appeared).
      const again = await fs.realpath(target);
      if (!isInside(root.path, again, this.opts)) throw this.notAllowed(`Path is outside the allowed folders: ${callerPath}`);
      return again;
    }
    return target;
  }

  /** Resolves an output file path: its folder per resolveOutputDir; the final component is kept as is (never followed). */
  async resolveOutputFile(p: string, create: boolean): Promise<{ dir: string; name: string; full: string }> {
    const resolved = this.syntax(p);
    const P = (this.opts.platform ?? process.platform) === "win32" ? nodePath.win32 : nodePath.posix;
    const name = P.basename(resolved);
    if (!name || name === "." || name === "..") throw mcpError("path-not-allowed", `Not a file path: ${p}`);
    const dir = await this.resolveOutputDir(P.dirname(resolved), create, p);
    return { dir, name, full: P.join(dir, name) };
  }
}

/** Configured roots (realpath'd once at startup). Missing roots are a startup error. */
export async function realpathRoots(rw: string[], ro: string[]): Promise<Root[]> {
  const out: Root[] = [];
  for (const [list, writable] of [[rw, true], [ro, false]] as const) {
    for (const d of list) {
      if (!nodePath.isAbsolute(d)) throw new Error(`allowed folder must be absolute: ${d}`);
      let real: string;
      try {
        real = await fs.realpath(d);
      } catch {
        throw new Error(`allowed folder does not exist: ${d}`);
      }
      const st = await fs.stat(real);
      if (!st.isDirectory()) throw new Error(`allowed folder is not a directory: ${d}`);
      out.push({ path: real, writable, source: "config" });
    }
  }
  return out;
}

export class StaticRoots implements RootsProvider {
  constructor(private readonly list: Root[], private readonly reason?: string) {}
  snapshot(): RootsSnapshot {
    return { roots: this.list, source: this.list.length ? "configured" : "none", reason: this.reason };
  }
  async get() {
    return this.snapshot();
  }
}

/**
 * file:// root URI → local path, via url.fileURLToPath (percent-decoding, Windows drive letters, UNC hosts); the
 * scheme is never just stripped. Throws for other schemes and for URIs that aren't valid file URLs.
 */
export function rootUriToPath(uri: string, platform: NodeJS.Platform = process.platform): string {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error("not a valid URI");
  }
  if (url.protocol !== "file:") throw new Error(`not a file:// URI (${url.protocol.replace(/:$/, "")})`);
  try {
    return fileURLToPath(url, { windows: platform === "win32" });
  } catch (e) {
    throw new Error(`not a usable file URI: ${(e as Error).message}`);
  }
}

export interface ClientRootsOptions {
  log?: Logger;
  platform?: NodeJS.Platform;
  /** Defaults to fs.realpath + stat (injectable for tests). */
  resolveDir?: (p: string) => Promise<string>;
}

async function realDir(p: string): Promise<string> {
  const real = await fs.realpath(p);
  if (!(await fs.stat(real)).isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
  return real;
}

/**
 * Client roots (local mode, only when no folders are configured, D-13): fetched via roots/list after `initialized`,
 * refreshed on notifications/roots/list_changed. An empty list disables paths (§11.1). A failing roots/list keeps
 * the last list that was received (it never wipes working roots because of a transient error).
 */
export class ClientRoots implements RootsProvider {
  private roots: Root[] = [];
  private pending?: Promise<boolean>;
  private fetched = false;
  private reason = "the client has not provided workspace roots";
  private status: ClientRootsStatus = "waiting";
  constructor(private readonly fetcher: () => Promise<{ uri: string; name?: string }[]>, private readonly opts: ClientRootsOptions = {}) {}

  /** Fetches roots/list again; resolves to true when the effective set of roots changed. */
  refresh(): Promise<boolean> {
    const log = this.opts.log;
    const run = (async () => {
      const before = this.key();
      try {
        const list = await this.fetcher();
        const out: Root[] = [];
        const skipped: { uri: string; reason: string }[] = [];
        for (const r of list) {
          const uri = typeof r?.uri === "string" ? r.uri : String(r?.uri);
          let local: string;
          try {
            local = rootUriToPath(uri, this.opts.platform);
          } catch (e) {
            skipped.push({ uri: log ? log.p(uri) : uri, reason: (e as Error).message });
            continue;
          }
          try {
            const real = await (this.opts.resolveDir ?? realDir)(local);
            if (!out.some((o) => o.path === real)) out.push({ path: real, writable: true, source: "client" });
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            skipped.push({ uri: log ? log.p(uri) : uri, reason: code === "ENOENT" ? "folder does not exist" : code === "ENOTDIR" ? "not a directory" : `can't access the folder (${code ?? (e as Error).message})` });
          }
        }
        this.roots = out;
        this.reason = out.length ? "" : list.length ? "none of the client's workspace roots is a usable local folder" : "the client's roots/list is empty";
        this.status = out.length ? "received" : "empty";
        log?.info("client roots received", {
          received: list.length,
          count: out.length,
          roots: out.map((r) => log.p(r.path)),
          skipped,
          ...(out.length ? {} : { effect: "file paths disabled" }),
        });
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        if (this.roots.length) {
          log?.warn("roots/list failed; keeping the previous client roots", { error: msg, count: this.roots.length, roots: this.roots.map((r) => log.p(r.path)) });
        } else {
          this.reason = "the client did not answer roots/list";
          this.status = "failed";
          log?.warn("roots/list failed; file paths disabled", { error: msg, count: 0 });
        }
      } finally {
        this.fetched = true;
      }
      return this.key() !== before;
    })();
    this.pending = run;
    return run;
  }

  private key(): string {
    return JSON.stringify([this.roots.map((r) => r.path), this.fetched ? this.reason : "pending", this.status]);
  }

  /** The client doesn't declare the roots capability (or client roots are switched off). */
  disable(reason: string, status: ClientRootsStatus = "unsupported") {
    this.reason = reason;
    this.status = status;
    this.fetched = true;
  }

  snapshot(): RootsSnapshot {
    return { roots: this.roots, source: this.roots.length ? "client" : "none", reason: this.reason, pending: !this.fetched, client: this.status };
  }

  async get() {
    if (this.pending) await this.pending;
    return this.snapshot();
  }

  get ready() {
    return this.fetched;
  }
}

/**
 * Configured roots combined with the client's workspace roots (local mode). The effective set is the union:
 * configured roots first, then client roots (read-write) that aren't already configured. A configured read-only
 * folder stays read-only even inside a client root (findRoot). Empty or failed client roots never remove the
 * configured ones.
 */
export class CombinedRoots implements RootsProvider {
  constructor(public readonly configured: Root[], public readonly client: ClientRoots) {}

  private combine(c: RootsSnapshot): RootsSnapshot {
    const roots = [...this.configured];
    for (const r of c.roots) if (!roots.some((x) => x.path === r.path)) roots.push(r);
    const source = this.configured.length ? "configured" : c.roots.length ? "client" : "none";
    return { roots, source, reason: roots.length ? undefined : c.reason, pending: c.pending, client: c.client };
  }

  snapshot(): RootsSnapshot {
    return this.combine(this.client.snapshot());
  }

  async get(): Promise<RootsSnapshot> {
    return this.combine(await this.client.get());
  }
}

/** Opens once, checks through the same handle (fstat), reads. Size check happens before reading. */
export async function readFileChecked(real: string, callerPath: string, maxBytes?: { name: string; value: number }): Promise<Buffer> {
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(real, "r");
  } catch (e) {
    throw fsErr(e, callerPath, "file");
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw mcpError("not-a-file", `Not a regular file: ${callerPath}`);
    if (maxBytes && st.size > maxBytes.value) {
      throw mcpError("precheck-too-large", `${callerPath} is ${st.size} bytes; the limit is ${maxBytes.value}.`, "Split the file.", {
        limit: { name: maxBytes.name, value: maxBytes.value, actual: st.size },
      });
    }
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}
