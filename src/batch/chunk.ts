import { base64Len } from "../base64.js";
import { zipSizeUpperBound } from "./zip.js";

export interface ChunkItem {
  entryName: string;
  size: number;
}

export interface ChunkCaps {
  maxEntries: number;
  maxUnpacked: number;
  maxZipBytes: number; // json.maxDecodedContentBytes
  maxBody: number; // maxRequestBodyBytes.json
  maxResponse: number; // SUBTITLE_MCP_BATCH_MAX_RESPONSE_BYTES
  profileBytes: number;
  outputsPerEntry: number;
}

export function estimateResponse(items: ChunkItem[], outputsPerEntry: number): number {
  const total = items.reduce((s, i) => s + i.size, 0);
  return Math.ceil(total * outputsPerEntry * 1.5 * (4 / 3)) + 65536;
}

export function fits(items: ChunkItem[], c: ChunkCaps): boolean {
  if (items.length > c.maxEntries) return false;
  const unpacked = items.reduce((s, i) => s + i.size, 0);
  if (unpacked > c.maxUnpacked) return false;
  const zipBytes = zipSizeUpperBound(items.map((i) => ({ name: i.entryName, size: i.size })));
  if (zipBytes > c.maxZipBytes) return false;
  if (base64Len(zipBytes) + c.profileBytes + 1024 > c.maxBody) return false;
  if (estimateResponse(items, c.outputsPerEntry) > c.maxResponse) return false;
  return true;
}

/** Greedy chunking in the given (sorted) order. Items that can't fit even alone are returned separately. */
export function chunkItems<T extends ChunkItem>(items: T[], c: ChunkCaps): { chunks: T[][]; oversized: T[] } {
  const chunks: T[][] = [];
  const oversized: T[] = [];
  let cur: T[] = [];
  for (const it of items) {
    if (!fits([it], c)) {
      oversized.push(it);
      continue;
    }
    if (fits([...cur, it], c)) cur.push(it);
    else {
      if (cur.length) chunks.push(cur);
      cur = [it];
    }
  }
  if (cur.length) chunks.push(cur);
  return { chunks, oversized };
}
