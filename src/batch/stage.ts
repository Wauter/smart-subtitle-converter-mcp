import nodePath from "node:path";
import fsp from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { mcpError } from "../errors.js";
import type { PathGuard } from "../fs/guard.js";
import type { Logger } from "../log.js";
import { openStaging, realFsOps, STAGING_DIR, stagingName, type FsOps } from "../fs/write.js";
import { WRITE_HINTS, writeFailure } from "../fs/writeErrors.js";

/**
 * D-44 all-or-nothing batch output, staged per D-38 in the output root's staging folder:
 * `<output-root>/.subtitle-mcp-staging/<dirname>.<6 hex>.partial/`. Only when every file succeeded is the whole
 * folder renamed to `outputDir` with one rename(2) (missing parents are created just before). On any failure the
 * staging folder is deleted, so a partial result never appears. The sweep (fs/sweep.ts) reaps orphans by age; the
 * folder's mtime is refreshed after each chunk so an in-progress batch is never reaped.
 */
const DIR_EXISTS_HINT = "Choose a new folder name, or ask the user to remove the existing folder.";

export class BatchStage {
  private dir?: string;
  private files = 0;
  /** `<output-root>/.subtitle-mcp-staging`, set by check(). */
  stagingRoot = "";

  private constructor(
    /** The caller's outputDir string (for messages). */
    readonly callerDir: string,
    /** Final folder: realpath'd nearest existing ancestor + the missing components. */
    readonly final: string,
    private readonly guard: PathGuard,
    private readonly log: Logger,
    private readonly ops: FsOps,
    private readonly rnd: (n: number) => Buffer,
  ) {}

  /**
   * Checks before any API call: outputDir must not exist yet (D-44); its nearest existing ancestor must be in a
   * writable root and on the same device as that root's staging folder (D-41). Creates nothing but the staging folder.
   */
  static async prepare(guard: PathGuard, outputDir: string, log: Logger, ops: FsOps = realFsOps, rnd: (n: number) => Buffer = randomBytes): Promise<BatchStage> {
    const resolved = nodePath.resolve(outputDir);
    const name = nodePath.basename(resolved);
    if (!nodePath.isAbsolute(outputDir) || !name || name === "." || name === ".." || name === STAGING_DIR) {
      throw mcpError("path-not-allowed", `Not a usable output folder: ${outputDir}`, "Give an absolute path to a new folder.");
    }
    // Validates syntax, roots (read-write) and the staging-folder ban on the parent; creates nothing. The last
    // segment is checked with lstat only, so a file or (dangling) symlink there counts as existing.
    const final = nodePath.join(await guard.resolveOutputDir(nodePath.dirname(resolved), false, outputDir), name);
    if (await ops.lstat(final).catch(() => null)) {
      throw mcpError(
        "output-dir-exists",
        `The output folder already exists: ${outputDir}. convert_batch writes into a new folder only. Nothing was sent.`,
        DIR_EXISTS_HINT,
        { path: outputDir },
      );
    }
    return new BatchStage(outputDir, final, guard, log, ops, rnd);
  }

  /**
   * Just before the first API request (§5.7.1 order): finds the output root of outputDir's nearest existing ancestor,
   * makes sure its staging folder is usable, and compares devices (D-41: a mount inside the root → cross-device).
   */
  async check(): Promise<void> {
    // Nearest existing ancestor (already realpath'd by the guard).
    let anc = nodePath.dirname(this.final);
    let ancStat: import("node:fs").Stats | null = null;
    for (;;) {
      ancStat = await this.ops.stat(anc).catch(() => null);
      if (ancStat) break;
      const up = nodePath.dirname(anc);
      if (up === anc) throw mcpError("path-not-found", `Not found: ${this.callerDir}`);
      anc = up;
    }
    const root = await this.guard.outputRoot(anc);
    if (!root) throw mcpError("path-not-allowed", `Path is outside the writable allowed folders: ${this.callerDir}`);
    const stagingRoot = nodePath.join(root, STAGING_DIR);
    this.stagingRoot = stagingRoot;
    const unavailable = (e: unknown) => {
      const f = writeFailure(e, stagingRoot, { forceCode: "staging-unavailable", verb: "use the staging folder" });
      return mcpError("staging-unavailable", f.toolError.detail!, WRITE_HINTS["staging-unavailable"].replace("<root>", root), { path: this.callerDir, osError: f.toolError.osError });
    };
    let sst: import("node:fs").Stats;
    try {
      await this.ops.mkdir(stagingRoot);
      const l = await this.ops.lstat(stagingRoot);
      if (!l.isDirectory()) throw Object.assign(new Error("not a directory (or a symlink)"), { code: "ENOTDIR" });
      sst = await this.ops.stat(stagingRoot);
    } catch (e) {
      throw unavailable(e);
    }
    if (sst.dev !== ancStat.dev) {
      // D-41: a mount inside the root; never fall back to a non-atomic copy.
      throw mcpError(
          "cross-device",
          `Couldn't write ${this.callerDir}: ${anc} is on a different filesystem than the staging folder ${stagingRoot}. Nothing was sent.`,
          WRITE_HINTS["cross-device"],
          { path: this.callerDir, osError: { code: "EXDEV", message: "cross-device link" } },
      );
    }
    await this.ensureDir(); // §5.7.1: the batch staging folder exists before the first request
  }

  /** The caller-visible final path of a staged file. */
  finalPath(relDir: string, name: string): string {
    return nodePath.join(this.callerDir, ...(relDir ? relDir.split("/") : []), name);
  }

  private async ensureDir(): Promise<string> {
    if (this.dir) return this.dir;
    if (!this.stagingRoot) await this.check();
    const base = nodePath.basename(this.final);
    for (let i = 0; i < 5; i++) {
      const d = nodePath.join(this.stagingRoot, stagingName(base, this.rnd(3).toString("hex")));
      try {
        await fsp.mkdir(d, { mode: 0o755 });
        this.dir = d;
        openStaging.add(d);
        return d;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        const f = writeFailure(e, this.stagingRoot, { forceCode: "staging-unavailable", verb: "create a batch folder in" });
        throw mcpError("staging-unavailable", f.toolError.detail!, WRITE_HINTS["staging-unavailable"].replace("<root>", nodePath.dirname(this.stagingRoot)), { path: this.callerDir, osError: f.toolError.osError });
      }
    }
    throw mcpError("staging-unavailable", `No free batch staging folder name in ${this.stagingRoot} after 5 tries.`, WRITE_HINTS["staging-unavailable"].replace("<root>", nodePath.dirname(this.stagingRoot)), { path: this.callerDir });
  }

  /** Refreshes the staging folder's mtime (after each chunk) so the age-based sweep never reaps a live batch. */
  async touch(): Promise<void> {
    if (!this.dir) return;
    const now = new Date();
    await fsp.utimes(this.dir, now, now).catch(() => {});
  }

  /** Stages one output (O_EXCL: a second output to the same path in this call is a clash, never renamed). */
  async write(relDir: string, name: string, data: Uint8Array, sourceLabel: string, clashWith?: string): Promise<string> {
    const shown = this.finalPath(relDir, name);
    const dir = await this.ensureDir();
    const sub = relDir ? nodePath.join(dir, ...relDir.split("/")) : dir;
    try {
      await fsp.mkdir(sub, { recursive: true });
    } catch (e) {
      throw writeFailure(e, shown, { verb: "create the folder for" });
    }
    let fh: import("node:fs/promises").FileHandle;
    try {
      fh = await this.ops.open(nodePath.join(sub, name), "wx", 0o644);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        throw mcpError(
          "ambiguous-batch-names",
          `Output ${shown} was already produced in this call${clashWith ? ` from ${clashWith}` : ""}; ${sourceLabel} maps to the same path. Nothing was renamed.`,
          "Rename the clashing files or split them into separate batches; check `profile.target.fileName` (include `{stem}`).",
          { groups: [[clashWith ?? "", sourceLabel]], path: shown },
        );
      }
      throw writeFailure(e, shown);
    }
    try {
      await fh.writeFile(data);
      await fh.sync();
    } catch (e) {
      await fh.close().catch(() => {});
      await this.ops.unlink(nodePath.join(sub, name)).catch(() => {});
      throw writeFailure(e, shown);
    } finally {
      await fh.close().catch(() => {});
    }
    this.files++;
    return shown;
  }

  /** All files succeeded: create missing parents of outputDir now, then one rename(2) of the staging folder. */
  async commit(): Promise<void> {
    const dir = await this.ensureDir(); // an all-skipped batch still gets its (empty) folder
    const appeared = () => mcpError("output-dir-exists", `The output folder ${this.callerDir} appeared during conversion; nothing was written.`, DIR_EXISTS_HINT, { path: this.callerDir });
    try {
      await this.ops.fsyncDir(dir).catch(() => {});
      const parent = await this.guard.resolveOutputDir(nodePath.dirname(this.final), true, this.callerDir);
      const target = nodePath.join(parent, nodePath.basename(this.final));
      if (await this.ops.lstat(target).catch(() => null)) throw appeared();
      try {
        await this.ops.rename(dir, target);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST" || code === "ENOTEMPTY" || ((code === "EPERM" || code === "ENOTDIR" || code === "EISDIR") && (await this.ops.lstat(target).catch(() => null)))) throw appeared();
        throw writeFailure(e, this.callerDir, { verb: "move the staged batch to", ...(code === "EXDEV" ? { forceCode: "cross-device" as const } : {}) });
      }
      openStaging.delete(dir);
      this.dir = undefined;
      await this.ops.fsyncDir(parent).catch(() => {});
    } catch (e) {
      await this.discard();
      throw e;
    }
    this.log.info("batch-committed", { path: this.log.p(this.final), files: this.files });
  }

  /** Any failure: delete everything staged (never a partial outputDir). The staging root itself stays (D-38). */
  async discard(): Promise<void> {
    if (this.dir) {
      const d = this.dir;
      await fsp.rm(d, { recursive: true, force: true }).catch((e) => this.log.warn("could not remove batch staging folder", { path: this.log.p(d), error: (e as Error).message }));
      openStaging.delete(d);
      this.dir = undefined;
    }
  }
}
