/* eslint-disable no-control-regex */
import fsp from "node:fs/promises";
import nodePath from "node:path";
import { randomBytes } from "node:crypto";
import { mcpError, ToolFailure, type WarningT } from "../errors.js";
import type { Logger } from "../log.js";
import { className, classifyErrno, osErrorOf, WRITE_HINTS, writeFailure } from "./writeErrors.js";

export type IfExists = "error" | "replace" | "archive" | "delete";
export type WriteAction = "written" | "replaced" | "archived" | "deleted";

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
export const BAK_RE = /\.\d{8}-\d{6}\.bak$/;

/** `<finalname>.<6 hex>.partial`, shortening <finalname> from the end to fit 255 bytes. */
export function stagingName(finalName: string, hex: string): string {
  const fixed = Buffer.byteLength(`.${hex}.partial`);
  let name = finalName;
  while (Buffer.byteLength(name) + fixed > 255 && name.length > 1) name = name.slice(0, -1);
  return `${name}.${hex}.partial`;
}

export function utcStamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
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
  dir: string; // realpath'd destination folder in a writable root
  /** realpath of the output root (deepest writable root containing dir); resolved via rootOf when omitted. */
  root?: string;
  name: string; // final file name (sanitised)
  data: Uint8Array;
  ifExists: IfExists;
  /** Realpaths of source files; an output may never replace one. */
  sources?: Set<string>;
  /** Batch-internal: normalised paths committed earlier in this call (path → source). */
  committed?: Map<string, string>;
  /** Description of the source for batch clash messages. */
  sourceLabel?: string;
  signal?: AbortSignal;
}

export interface WriteResult {
  path: string;
  action: WriteAction;
  archivedTo?: string;
  warnings: WarningT[];
}

export const normKey = (p: string) => p.normalize("NFC").toLowerCase();

export class SafeWriter {
  constructor(
    private readonly log: Logger,
    private readonly ops: FsOps = realFsOps,
    private readonly clock: () => Date = () => new Date(),
    private readonly rnd: (n: number) => Buffer = randomBytes,
    /** Resolves the output root of a destination folder (D-38). */
    public rootOf: (dir: string) => Promise<string | undefined> = async () => undefined,
  ) {}

  async write(req: WriteRequest): Promise<WriteResult> {
    const { dir, name, ifExists } = req;
    const target = nodePath.join(dir, name);
    const warnings: WarningT[] = [];
    let staging: string | undefined;
    let archivedTo: string | undefined;
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
      if (req.committed?.has(normKey(target))) {
        const other = req.committed.get(normKey(target));
        throw mcpError(
          "ambiguous-batch-names",
          `Output ${target} was already written in this call from ${other}; ${req.sourceLabel ?? "this file"} maps to the same path. Nothing was renamed.`,
          "Rename the clashing files or split them into separate batches; check `profile.target.fileName` (include `{stem}`).",
          { groups: [[other ?? "", req.sourceLabel ?? ""]], path: target },
        );
      }
      const existing = await this.lstatOrNull(target);
      let action: WriteAction = "written";
      if (existing) {
        if (existing.isDirectory()) throw mcpError("output-exists", `A folder exists at the output path: ${target}`, "Choose another output folder.", { path: target });
        switch (ifExists) {
          case "error":
            throw mcpError("output-exists", `Output already exists: ${target}`, "Ask the user whether to replace, archive or delete this file, or choose another output folder.", { path: target });
          case "archive": {
            const bak = `${target}.${utcStamp(this.clock())}.bak`;
            if (await this.lstatOrNull(bak)) {
              throw mcpError("archive-exists", `Archive name already taken: ${bak}`, "Try again in a second, or choose replace/delete or another folder.", { path: bak });
            }
            try {
              await this.noClobberMove(target, bak);
            } catch (e) {
              if (e instanceof ToolFailure && e.toolError.code === "output-exists") throw mcpError("archive-exists", `Archive name already taken: ${bak}`, "Try again in a second, or choose replace/delete or another folder.", { path: bak });
              if (e instanceof ToolFailure) throw e;
              const cls = classifyErrno((e as NodeJS.ErrnoException).code, { existingTarget: true });
              const f = writeFailure(e, target, { existingTarget: true, verb: "archive" });
              throw mcpError("archive-failed", `${f.toolError.detail} (${className(cls)})`, WRITE_HINTS[cls], { path: target, osError: f.toolError.osError });
            }
            archivedTo = bak;
            action = "archived";
            this.log.info("archived", { from: this.log.p(target), to: this.log.p(bak) });
            break;
          }
          case "delete":
            try {
              await this.ops.unlink(target);
            } catch (e) {
              const cls = classifyErrno((e as NodeJS.ErrnoException).code, { existingTarget: true });
              const f = writeFailure(e, target, { existingTarget: true, verb: "delete" });
              throw mcpError("delete-failed", `${f.toolError.detail} (${className(cls)})`, WRITE_HINTS[cls], { path: target, osError: f.toolError.osError });
            }
            action = "deleted";
            this.log.info("deleted", { path: this.log.p(target) });
            break;
          case "replace":
            action = "replaced";
            break;
        }
      }
      aborted();

      // Step 4: commit.
      if (action === "replaced") {
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
      req.committed?.set(normKey(target), req.sourceLabel ?? "");
      return { path: target, action, ...(archivedTo ? { archivedTo } : {}), warnings };
    } catch (err) {
      // Step 5: roll back.
      if (staging) await this.ops.unlink(staging).catch(() => {});
      if (archivedTo) {
        try {
          await this.noClobberMove(archivedTo, target);
          archivedTo = undefined;
        } catch {
          const w = { code: "mcp-archive-not-restored", message: `The previous file was kept at ${archivedTo}; restore it by hand.` };
          if (err instanceof ToolFailure) {
            err.toolError.detail = `${err.toolError.detail ?? ""} The previous file is at ${archivedTo}.`.trim();
            throw new ToolFailure(err.toolError, [...err.warnings, w]);
          }
        }
      }
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
      if (code === "EEXIST") throw mcpError("output-exists", `Output ${appearedDetail}: ${to}`, "Ask the user whether to replace, archive or delete this file, or choose another output folder.", { path: to });
      if (code === "EXDEV") throw writeFailure(e, to, { forceCode: "cross-device" });
      if (!NO_LINK_CODES.has(code)) throw e;
      if (await this.lstatOrNull(to)) throw mcpError("output-exists", `Output ${appearedDetail}: ${to}`, "Ask the user whether to replace, archive or delete this file, or choose another output folder.", { path: to });
      await this.ops.rename(from, to);
      return;
    }
    await this.ops.unlink(from).catch(() => {});
  }
}
