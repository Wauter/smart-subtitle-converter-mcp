import fsp from "node:fs/promises";
import nodePath from "node:path";
import type { Logger } from "../log.js";
import type { RootsProvider } from "./guard.js";
import { openStaging, STAGING_DIR, STAGING_RE } from "./write.js";

/**
 * D-38: deletes orphaned staging files older than maxAgeMs, looking ONLY inside `<root>/.subtitle-mcp-staging/` of
 * each read-write root. Only that folder is listed (a stale batch folder is removed as a whole); no symlinks are
 * followed and the staging folder itself stays. No persistent state.
 */
export async function sweepOnce(roots: RootsProvider, maxAgeMs: number, log: Logger, now: () => number = Date.now): Promise<number> {
  const { roots: list } = await roots.get();
  let removed = 0;
  for (const root of list) {
    if (!root.writable) continue;
    const sdir = nodePath.join(root.path, STAGING_DIR);
    try {
      const st = await fsp.lstat(sdir);
      if (!st.isDirectory()) continue; // missing, a file, or a symlink: skip
    } catch {
      continue;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(sdir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = nodePath.join(sdir, ent.name);
      // Files (convert_subtitle) and folders (convert_batch, D-44) named <name>.<6 hex>.partial; never symlinks.
      if (!(ent.isFile() || ent.isDirectory()) || !STAGING_RE.test(ent.name) || openStaging.has(full)) continue;
      try {
        const st = await fsp.lstat(full);
        if (!(st.isFile() || st.isDirectory()) || now() - st.mtimeMs <= maxAgeMs) continue;
        if (st.isDirectory()) await fsp.rm(full, { recursive: true, force: true }); // rm never follows symlinks inside
        else await fsp.unlink(full);
        removed++;
        log.info("sweep-removed", { path: log.p(full) });
      } catch {
        /* raced or no permission: ignore */
      }
    }
  }
  return removed;
}

export function startSweeper(roots: RootsProvider, maxAgeMs: number, log: Logger): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await sweepOnce(roots, maxAgeMs, log);
    } catch (e) {
      log.warn("sweep failed", { error: (e as Error).message });
    } finally {
      running = false;
    }
  };
  setImmediate(run);
  const t = setInterval(run, Math.min(maxAgeMs, 15 * 60_000));
  t.unref();
  return () => clearInterval(t);
}
