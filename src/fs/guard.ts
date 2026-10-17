import fs from "node:fs/promises";
import nodePath from "node:path";
import { mcpError, ToolFailure } from "../errors.js";

export interface Root {
  path: string; // realpath
  writable: boolean;
}

/** Provides the current roots; `reason` explains why there are none. */
export interface RootsProvider {
  get(): Promise<{ roots: Root[]; source: "configured" | "client" | "none"; reason?: string }>;
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
  // Prefer a writable root when nested.
  const hits = roots.filter((r) => isInside(r.path, real, opts));
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

  private async active(): Promise<Root[]> {
    const r = await this.roots.get();
    if (r.roots.length === 0) {
      throw mcpError(
        "paths-disabled",
        `File paths are disabled: ${r.reason ?? "no allowed folders are configured"}.`,
        "Set SUBTITLE_MCP_ALLOWED_DIRS (or SUBTITLE_MCP_READONLY_DIRS), or use a client that provides workspace roots; or pass inline content.",
      );
    }
    return r.roots;
  }

  /** Resolves an input file: realpath inside any root, must be a regular file. */
  async resolveInputFile(p: string): Promise<{ real: string; root: Root; size: number }> {
    const roots = await this.active();
    const resolved = checkPathSyntax(p, this.opts);
    let real: string;
    try {
      real = await fs.realpath(resolved);
    } catch (e) {
      // Distinguish "outside roots" from "missing" without leaking: only say not found if lexically inside a root.
      if (!findRoot(roots, resolved, this.opts)) throw mcpError("path-not-allowed", `Path is outside the allowed folders: ${p}`);
      throw fsErr(e, p, "file");
    }
    const root = findRoot(roots, real, this.opts);
    if (!root) throw mcpError("path-not-allowed", `Path is outside the allowed folders: ${p}`, "Use a path inside an allowed folder (symlinks must stay inside too).");
    const st = await fs.stat(real).catch((e) => {
      throw fsErr(e, p, "file");
    });
    if (!st.isFile()) throw mcpError("not-a-file", `Not a regular file: ${p}`);
    return { real, root, size: st.size };
  }

  /** Resolves an input directory: realpath inside any root. */
  async resolveInputDir(p: string): Promise<{ real: string; root: Root }> {
    const roots = await this.active();
    const resolved = checkPathSyntax(p, this.opts);
    rejectStaging(resolved, p);
    let real: string;
    try {
      real = await fs.realpath(resolved);
    } catch (e) {
      if (!findRoot(roots, resolved, this.opts)) throw mcpError("path-not-allowed", `Path is outside the allowed folders: ${p}`);
      throw fsErr(e, p, "dir");
    }
    const root = findRoot(roots, real, this.opts);
    if (!root) throw mcpError("path-not-allowed", `Path is outside the allowed folders: ${p}`);
    const st = await fs.stat(real);
    if (!st.isDirectory()) throw mcpError("not-a-directory", `Not a directory: ${p}`);
    return { real, root };
  }

  /** Is a realpath inside an allowed root (used for symlinks found while walking)? */
  /** D-38: output root (deepest writable root) of a realpath'd destination folder. */
  async outputRoot(realDir: string): Promise<string | undefined> {
    const r = await this.roots.get();
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
    const resolved = checkPathSyntax(p, this.opts);
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
    if (!root) throw mcpError("path-not-allowed", `Path is outside the allowed folders: ${callerPath}`);
    if (!root.writable) throw mcpError("path-not-allowed", `Path is in a read-only folder: ${callerPath}`, "Write to a folder in a read-write root (SUBTITLE_MCP_ALLOWED_DIRS).");
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
      if (!isInside(root.path, again, this.opts)) throw mcpError("path-not-allowed", `Path is outside the allowed folders: ${callerPath}`);
      return again;
    }
    return target;
  }

  /** Resolves an output file path: its folder per resolveOutputDir; the final component is kept as is (never followed). */
  async resolveOutputFile(p: string, create: boolean): Promise<{ dir: string; name: string; full: string }> {
    const resolved = checkPathSyntax(p, this.opts);
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
      out.push({ path: real, writable });
    }
  }
  return out;
}

export class StaticRoots implements RootsProvider {
  constructor(private readonly list: Root[], private readonly reason?: string) {}
  async get() {
    return { roots: this.list, source: this.list.length ? ("configured" as const) : ("none" as const), reason: this.reason };
  }
}

/** Client roots (local mode): fetched via roots/list after `initialized`, refreshed on list_changed. */
export class ClientRoots implements RootsProvider {
  private roots: Root[] = [];
  private pending?: Promise<void>;
  private fetched = false;
  private reason = "the client has not provided workspace roots";
  constructor(private readonly fetcher: () => Promise<{ uri: string }[]>, private readonly onError?: (e: unknown) => void) {}

  refresh(): Promise<void> {
    const run = (async () => {
      try {
        const list = await this.fetcher();
        const out: Root[] = [];
        for (const r of list) {
          if (!r.uri.startsWith("file://")) continue;
          try {
            const p = new URL(r.uri);
            const { fileURLToPath } = await import("node:url");
            const real = await fs.realpath(fileURLToPath(p));
            if ((await fs.stat(real)).isDirectory()) out.push({ path: real, writable: true });
          } catch {
            /* ignore missing roots */
          }
        }
        this.roots = out;
        this.reason = out.length ? "" : "the client's roots/list is empty";
      } catch (e) {
        this.onError?.(e);
        this.roots = [];
        this.reason = "the client did not answer roots/list";
      } finally {
        this.fetched = true;
      }
    })();
    this.pending = run;
    return run;
  }

  disable(reason: string) {
    this.reason = reason;
    this.fetched = true;
  }

  async get() {
    if (this.pending) await this.pending;
    return { roots: this.roots, source: this.roots.length ? ("client" as const) : ("none" as const), reason: this.reason };
  }

  get ready() {
    return this.fetched;
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
