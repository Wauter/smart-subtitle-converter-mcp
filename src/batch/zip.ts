/* eslint-disable no-control-regex */
import nodePath from "node:path";
import { deflateSync, zipSync, type Zippable } from "fflate";

/**
 * Mirrors the target API's unsafe-zip rule exactly (§5.7.2, D-36): a `..` path segment, a leading `/`, a backslash,
 * an `X:` drive letter or control characters; plus a top-level manifest.json (which the API would drop).
 */
export function needsAlias(name: string): boolean {
  return name.split("/").includes("..") || name.startsWith("/") || name.includes("\\") || /^[A-Za-z]:/.test(name) || /[\x00-\x1f\x7f]/.test(name) || name.toLowerCase() === "manifest.json";
}

export interface EntrySpec {
  name: string;
  data: Uint8Array;
}

/** Builds the zip in memory. Entries over 1 MB that would trip the ratio guard are stored, others deflated. */
export function buildZip(entries: EntrySpec[], maxRatio: number): Uint8Array {
  const z: Zippable = {};
  for (const e of entries) {
    let level: 0 | 6 = 6;
    if (e.data.length > 1_000_000) {
      const c = deflateSync(e.data, { level: 6 }).length;
      if (e.data.length > c * maxRatio * 0.9) level = 0;
    }
    z[e.name] = [e.data, { level }];
  }
  return zipSync(z);
}

/** Upper bound for the zip size before building it (stored worst case + headers). */
export function zipSizeUpperBound(entries: { name: string; size: number }[]): number {
  let n = 22;
  for (const e of entries) {
    const nameLen = Buffer.byteLength(e.name);
    n += e.size + Math.ceil(e.size / 16384) * 5 + 64 + 30 + 46 + 2 * nameLen;
  }
  return n;
}

export const extOf = (name: string) => nodePath.posix.extname(name);
