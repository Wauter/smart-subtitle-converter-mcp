/* eslint-disable no-control-regex */
import fsp from "node:fs/promises";
import nodePath from "node:path";
import { randomBytes } from "node:crypto";
import { mcpError, ToolFailure, type WarningT } from "../errors.js";
import type { Logger } from "../log.js";
import { osErrorOf, WRITE_HINTS, writeFailure } from "./writeErrors.js";

export type IfExists = "error" | "replace";
export type WriteAction = "written" | "replaced";

/** Filesystem operations, injectable so tests can simulate EBUSY, missing hard-link support and races. */
export interface FsOps {
  open: typeof fsp.open;
  link: (a: string, b: string) => Promise<void>;
  rename: (a: string, b: string) => Promise<void>;
  unlink: (a: string) => Promise<void>;
  lstat: (p: string) => Promise<import("node:fs").Stats>;
  stat: (p: string) => Promise<import("node:fs").Stats>;
  mkdir: (p: string) => Promise<unknown>;
  realpath: (p: string) => Promise<string>;
  fsyncDir: (dir: string) => Promise<void>;
}

export const realFsOps: FsOps = {
  open: fsp.open,
  link: fsp.link,
  rename: fsp.rename,
  unlink: fsp.unlink,
  lstat: fsp.lstat,
  stat: fsp.stat,
  mkdir: (p) => fsp.mkdir(p, { recursive: true, mode: 0o755 }),
  realpath: fsp.realpath,
  fsyncDir: async (dir) => {
    if (process.platform === "win32") return;
    const fh = await fsp.open(dir, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  },
};

/** Staging files this process has open (skipped by the sweep). */
export const openStaging = new Set<string>();

/** D-38: the per-output-root staging folder. */
export const STAGING_DIR = ".subtitle-mcp-staging";
export const STAGING_RE = /^.+\.[0-9a-f]{6}\.partial$/;

/** `<finalname>.<6 hex>.partial`, shortening <finalname> from the end to fit 255 bytes. */
export function stagingName(finalName: string, hex: string): string {
  const fixed = Buffer.byteLength(`.${hex}.partial`);
  let name = finalName;
  while (Buffer.byteLength(name) + fixed > 255 && name.length > 1) name = name.slice(0, -1);
  return `${name}.${hex}.partial`;
}

/** Keeps only a safe basename (§5.6.2). Throws api-protocol-error. */
export function sanitizeOutputName(name: unknown): string {
  if (typeof name !== "string" || name.length === 0 || name === "." || name === ".." || /[\0/\\]/.test(name) || /[\x00-\x1f]/.test(name)) {
    throw mcpError("api-protocol-error", `The API returned an unsafe output file name: ${JSON.stringify(String(name)).slice(0, 120)}`, "Report this with the requestId.");
  }
  return name;
}

const LOCK_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ETXTBSY"]);
const NO_LINK_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EMLINK", "EINVAL"]);

export interface WriteRequest {
  signal?: AbortSignal;
  dir: string; // realpath'd destination folder in a writable root
  /** realpath of the output root (deepest writable root containing dir); resolved via rootOf when omitted. */
  root?: string;
  name: string; // final file name (sanitised)
  data: Uint8Array;
  ifExists: IfExists;
  /** Realpaths of source files; an output may never replace one. */
  sources?: Set<string>;

}

export interface WriteResult {
  path: string;
  action: WriteAction;
  warnings: WarningT[];
}

export const normKey = (p: string) => p.normalize("NFC").toLowerCase();

export class SafeWriter {
  constructor(
    private readonly log: Logger,
    private readonly ops: FsOps = realFsOps,
    private readonly rnd: (n: number) => Buffer = randomBytes,
    /** Resolves the output root of a destination folder (D-38). */
    public rootOf: (dir: string) => Promise<string | undefined> = async () => undefined,
  ) {}

  async write(req: WriteRequest): Promise<WriteResult> {
    const { dir, name, ifExists } = req;
    if (ifExists !== "error" && ifExists !== "replace") throw mcpError("invalid-arguments", "Unknown ifExists policy.", "Valid ifExists values: error | replace.");
    const target = nodePath.join(dir, name);
    // H2: a hidden name is never created (defence in depth; the tools check first).
    if (name.startsWith(".")) throw mcpError("hidden-path", `Hidden files and folders are never read, listed or written: ${target}`, "Use a file name without a leading dot.", { path: target });
    const warnings: WarningT[] = [];
    let staging: string | undefined;
    const aborted = () => {
      if (req.signal?.aborted) throw mcpError("cancelled", "The client cancelled the request.");
    };
    try {
      aborted();
      // Step 2: stage (O_EXCL, retry with a new id up to 5 times), fsync.
      const root = req.root ?? (await this.rootOf(dir)) ?? dir;
      staging = await this.stage(root, dir, name, target, req.data);
      aborted();

      // Step 3: checks, then policy.
      if (req.sources && (await this.isSource(target, req.sources))) {
        throw mcpError("source-overwrite-refused", `Refusing to write over the source file: ${target}`, "Choose another output folder or file name.", { path: target });
      }
      const existing = await this.lstatOrNull(target);
      let action: WriteAction = "written";
      if (existing) {
        if (existing.isDirectory()) throw mcpError("output-exists", `A folder exists at the output path: ${target}`, "Choose another output folder.", { path: target });
        // H10: never write through, or replace, a symlink or special file.
        if (!existing.isFile()) throw mcpError("path-not-allowed", `The output path is a symlink or special file, which is never written or replaced: ${target}`, "Choose another output name.", { path: target });
        switch (ifExists) {
          case "error":
            throw mcpError("output-exists", `Output already exists: ${target}`, "Valid ifExists values: error | replace. Choose another path or explicitly replace; a previous job may have written or still be writing this location.", { path: target });
          case "replace":
            action = "replaced";
            break;
        }
      }
      aborted();

      // Step 4: commit.
      if (ifExists === "replace") {
        try {
          await this.ops.rename(staging, target);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code ?? "";
          if (LOCK_CODES.has(code) && (code === "EBUSY" || code === "ETXTBSY" || process.platform === "win32")) {
            throw writeFailure(e, target, { forceCode: "output-locked", verb: "replace" });
          }
          throw writeFailure(e, target, { existingTarget: true, verb: "replace" });
        }
      } else {
        await this.noClobberMove(staging, target, "appeared during conversion");
      }
      staging = undefined;
      await this.ops.fsyncDir(dir).catch(() => {});
      return { path: target, action, warnings };
    } catch (err) {
      // Step 5: roll back.
      if (staging) await this.ops.unlink(staging).catch(() => {});
      if (err instanceof ToolFailure) throw err;
      throw writeFailure(err, target);
    } finally {
      if (staging) openStaging.delete(staging);
    }
  }

  /** Step 2 [D-38]: stage in <root>/.subtitle-mcp-staging/ (created on demand), same device as the destination. */
  private async stage(root: string, dir: string, name: string, target: string, data: Uint8Array): Promise<string> {
    const sdir = nodePath.join(root, STAGING_DIR);
    const unavailable = (e: unknown, what: string) => {
      const os = osErrorOf(e);
      return mcpError("staging-unavailable", `Couldn't ${what} the staging folder ${sdir}: ${os.message} (${os.code}${os.syscall ? `, ${os.syscall}` : ""}).`, WRITE_HINTS["staging-unavailable"].replace("<root>", root), { path: target, osError: os });
    };
    try {
      await this.ops.mkdir(sdir);
    } catch (e) {
      throw unavailable(e, "create");
    }
    let sst: import("node:fs").Stats;
    try {
      sst = await this.ops.lstat(sdir);
    } catch (e) {
      throw unavailable(e, "open");
    }
    if (!sst.isDirectory()) {
      throw mcpError("staging-unavailable", `The staging folder ${sdir} is not a directory (or is a symlink).`, WRITE_HINTS["staging-unavailable"].replace("<root>", root), { path: target });
    }
    let dst: import("node:fs").Stats;
    try {
      dst = await this.ops.stat(dir);
    } catch (e) {
      throw writeFailure(e, target);
    }
    if (dst.dev !== sst.dev) {
      throw mcpError("cross-device", `Couldn't write ${target}: the folder is on a different filesystem than its output root ${root}.`, WRITE_HINTS["cross-device"], { path: target, osError: { code: "EXDEV", message: "cross-device link" } });
    }
    for (let i = 0; i < 5; i++) {
      const p = nodePath.join(sdir, stagingName(name, this.rnd(3).toString("hex")));
      let fh: import("node:fs/promises").FileHandle;
      try {
        fh = await this.ops.open(p, "wx", 0o644);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST") continue;
        if (code === "ENOSPC" || code === "EDQUOT" || code === "EROFS" || code === "EIO" || code === "ENAMETOOLONG") throw writeFailure(e, target);
        throw unavailable(e, "write to");
      }
      openStaging.add(p);
      try {
        await fh.writeFile(data);
        await fh.sync();
      } catch (e) {
        await fh.close().catch(() => {});
        await this.ops.unlink(p).catch(() => {});
        openStaging.delete(p);
        throw writeFailure(e, target);
      }
      await fh.close();
      return p;
    }
    throw mcpError("staging-unavailable", `No free staging file name in ${sdir} after 5 tries.`, WRITE_HINTS["staging-unavailable"].replace("<root>", root), { path: target });
  }

  private async lstatOrNull(p: string) {
    try {
      return await this.ops.lstat(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  private async isSource(target: string, sources: Set<string>): Promise<boolean> {
    if (sources.has(target)) return true;
    try {
      const real = await this.ops.realpath(target);
      return sources.has(real);
    } catch {
      return false;
    }
  }

  /** link+unlink (atomic EEXIST); fallback: fresh lstat + rename where hard links are unsupported. */
  private async noClobberMove(from: string, to: string, appearedDetail = "exists"): Promise<void> {
    try {
      await this.ops.link(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (code === "EEXIST") throw mcpError("output-exists", `Output ${appearedDetail}: ${to}`, "Valid ifExists values: error | replace. Choose another path or explicitly replace; a previous job may have written or still be writing this location.", { path: to });
      if (code === "EXDEV") throw writeFailure(e, to, { forceCode: "cross-device" });
      if (!NO_LINK_CODES.has(code)) throw e;
      if (await this.lstatOrNull(to)) throw mcpError("output-exists", `Output ${appearedDetail}: ${to}`, "Valid ifExists values: error | replace. Choose another path or explicitly replace; a previous job may have written or still be writing this location.", { path: to });
      await this.ops.rename(from, to);
      return;
    }
    await this.ops.unlink(from).catch(() => {});
  }
}
