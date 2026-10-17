import fsp from "node:fs/promises";
import nodePath from "node:path";
import picomatch from "picomatch";
import { mcpError, ToolFailure, type ToolError } from "../errors.js";
import type { PathGuard } from "../fs/guard.js";
import { BAK_RE, STAGING_DIR } from "../fs/write.js";

export interface SelectedFile {
  /** Caller-facing absolute path (inputDir join rel, or the given path). */
  source: string;
  real: string;
  size: number;
  /** Relative path with '/' separators (inputDir mode) or basename. */
  rel: string;
}

export interface PreEntry {
  source: string;
  status: "failed" | "skipped";
  reason?: string;
  error?: ToolError;
}

export interface Selection {
  files: SelectedFile[];
  pre: PreEntry[];
}

const isBak = (n: string) => BAK_RE.test(n);
/** D-38: inside a `.subtitle-mcp-staging/` folder (any path segment). */
export const inStaging = (p: string) => p.split(/[\\/]/).includes(STAGING_DIR);

/** Folder walk + picomatch (§5.7.1). */
export async function selectFromDir(guard: PathGuard, inputDir: string, pattern: string, maxFiles: number): Promise<Selection> {
  const { real: rootReal } = await guard.resolveInputDir(inputDir);
  const isMatch = picomatch(pattern || "*", { dot: true });
  const files: SelectedFile[] = [];
  const pre: PreEntry[] = [];
  const visitedDirs = new Set<string>([rootReal]);
  const walk = async (realDir: string, relDir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(realDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const ent of entries) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      const shown = nodePath.join(inputDir, ...rel.split("/"));
      let full = nodePath.join(realDir, ent.name);
      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      if (ent.isSymbolicLink()) {
        let target: string;
        try {
          target = await fsp.realpath(full);
        } catch {
          continue;
        }
        if (!(await guard.allows(target))) {
          if (isMatch(rel)) pre.push({ source: shown, status: "skipped", reason: "path-not-allowed" });
          continue;
        }
        const st = await fsp.stat(target);
        full = target;
        isDir = st.isDirectory();
        isFile = st.isFile();
      }
      const macos = ent.name === "__MACOSX" || ent.name.startsWith("._") || relDir.split("/").includes("__MACOSX");
      if (isDir) {
        // Dot folders, and always the staging folder (D-38), are never descended into, whatever `pattern` says.
        if (ent.name === STAGING_DIR || ent.name.startsWith(".") || visitedDirs.has(full)) continue;
        visitedDirs.add(full);
        await walk(full, rel);
        continue;
      }
      if (!isFile || !isMatch(rel)) continue;
      if (macos) {
        pre.push({ source: shown, status: "skipped", reason: "macos-metadata" });
        continue;
      }
      if (ent.name.startsWith(".") || isBak(ent.name)) continue; // dotfiles and archives: never selected
      if (ent.name.toLowerCase().endsWith(".zip")) {
        pre.push({ source: shown, status: "skipped", reason: "nested-zip" });
        continue;
      }
      const st = await fsp.stat(full);
      files.push({ source: shown, real: full, size: st.size, rel });
      if (files.length > maxFiles) {
        throw mcpError("invalid-arguments", `More than ${maxFiles} files match; narrow the pattern or split the folder.`, "The limit is SUBTITLE_MCP_BATCH_MAX_FILES.");
      }
    }
  };
  await walk(rootReal, "");
  files.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
  return { files, pre };
}

/** Explicit paths (§5.7.1): validated one by one; duplicates by realpath removed. */
export async function selectFromPaths(guard: PathGuard, paths: string[], maxFiles: number): Promise<Selection> {
  if (paths.length > maxFiles) throw mcpError("invalid-arguments", `More than ${maxFiles} paths given.`, "The limit is SUBTITLE_MCP_BATCH_MAX_FILES.");
  const files: SelectedFile[] = [];
  const pre: PreEntry[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const base = nodePath.basename(p);
    if (inStaging(p) || isBak(base)) {
      pre.push({ source: p, status: "skipped", reason: "mcp-artifact" });
      continue;
    }
    if (base.startsWith("._") || p.split(/[\\/]/).includes("__MACOSX")) {
      pre.push({ source: p, status: "skipped", reason: "macos-metadata" });
      continue;
    }
    if (base.toLowerCase().endsWith(".zip")) {
      pre.push({ source: p, status: "skipped", reason: "nested-zip" });
      continue;
    }
    try {
      const r = await guard.resolveInputFile(p);
      if (seen.has(r.real)) continue;
      seen.add(r.real);
      files.push({ source: p, real: r.real, size: r.size, rel: base });
    } catch (e) {
      if (!(e instanceof ToolFailure)) throw e;
      if (e.toolError.code === "paths-disabled") throw e;
      pre.push({ source: p, status: "failed", error: e.toolError });
    }
  }
  return { files, pre };
}

/** stem = file name minus its last extension. */
export function stemOf(name: string): string {
  const ext = nodePath.posix.extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

/** D-29: entry folder + stem, NFC + lower case. Returns clashing groups of caller paths. */
export function ambiguousGroups(items: { source: string; entryName: string }[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const it of items) {
    const dir = nodePath.posix.dirname(it.entryName);
    const key = `${dir === "." ? "" : dir}/${stemOf(nodePath.posix.basename(it.entryName))}`.normalize("NFC").toLowerCase();
    const g = groups.get(key) ?? [];
    g.push(it.source);
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}
