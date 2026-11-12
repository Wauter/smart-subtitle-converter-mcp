import { createHash } from "node:crypto";
import { mcpError } from "../errors.js";

/**
 * Paged text for the model (preview_text) and the short inline-convert preview.
 *
 * Text is split into whole units: cues for SRT and WebVTT (blocks that contain a `-->` timing line, with any
 * header, NOTE or stray blank-line blocks attached to a neighbouring cue), lines for everything else. A page is
 * the longest run of whole units that fits in maxBytes UTF-8 bytes; a single unit larger than maxBytes is
 * returned alone. Concatenating every page gives back the full text exactly. Byte counts are UTF-8 without a BOM.
 */

/** Smallest page size a caller may ask for; smaller requests are raised to this. */
export const PREVIEW_MIN_BYTES = 4096;
/** Absolute ceiling for SUBTITLE_MCP_PREVIEW_MAX_BYTES (and so for any page). */
export const PREVIEW_HARD_CEILING_BYTES = 1_048_576;

export type Unit = "cue" | "line";

export interface Segments {
  unit: Unit;
  parts: string[];
  bytes: number[];
  totalBytes: number;
}

/** A block is a cue when one of its lines holds the SRT/WebVTT timing arrow (no HTML parsing involved). */
const TIMING_ARROW = "-->";
const BLANK_RUN = /\r?\n(?:[ \t]*\r?\n)+/g;

/** Text without a leading BOM: byte counts and pages never include it. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function cueParts(text: string): string[] | undefined {
  const blocks: string[] = [];
  let start = 0;
  for (const m of text.matchAll(BLANK_RUN)) {
    const end = (m.index ?? 0) + m[0].length;
    blocks.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) blocks.push(text.slice(start));
  const parts: string[] = [];
  let lead = "";
  for (const b of blocks) {
    if (b.includes(TIMING_ARROW)) { parts.push(lead + b); lead = ""; }
    else if (parts.length) parts[parts.length - 1] += b;
    else lead += b;
  }
  if (!parts.length) return undefined;
  return parts;
}

function lineParts(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Splits text (BOM already stripped) into cues when `cueFormat` and timing lines are present, else lines. */
export function segment(text: string, cueFormat: boolean): Segments {
  const cues = cueFormat ? cueParts(text) : undefined;
  const parts = cues ?? lineParts(text);
  const bytes = parts.map((p) => Buffer.byteLength(p, "utf8"));
  return { unit: cues ? "cue" : "line", parts, bytes, totalBytes: bytes.reduce((a, b) => a + b, 0) };
}

export interface Page {
  text: string;
  /** 0-based index of the first unit on this page. */
  start: number;
  /** 0-based index one past the last unit on this page. */
  end: number;
  returnedBytes: number;
  /** true when units remain after this page. */
  more: boolean;
}

/** Whole units from `start` while they fit in maxBytes; always at least one unit when any remain. */
export function takePage(s: Segments, start: number, maxBytes: number): Page {
  let end = start, n = 0;
  while (end < s.parts.length && (end === start || n + s.bytes[end] <= maxBytes)) {
    n += s.bytes[end];
    end++;
    if (n > maxBytes) break; // a single oversized unit goes alone
  }
  return { text: s.parts.slice(start, end).join(""), start, end, returnedBytes: n, more: end < s.parts.length };
}

/** Effective page size: the request (or the default) clamped to [PREVIEW_MIN_BYTES, max]. */
export function clampPageBytes(requested: number | undefined, def: number, max: number): number {
  return Math.min(max, Math.max(PREVIEW_MIN_BYTES, requested ?? def));
}

// ---------- cursor ----------

export interface Cursor {
  /** Which file: a short hash of the source key (job id + which today, a location later). */
  k: string;
  /** Fingerprint of the stored bytes the cursor was issued for. */
  h: string;
  u: Unit;
  /** 0-based index of the next unit. */
  f: number;
  /** Page size in effect when the cursor was issued; later pages keep it unless the call sets maxBytes. */
  m?: number;
}

const b64u = (b: Buffer) => b.toString("base64url");
export const hashKey = (s: string) => b64u(createHash("sha256").update(s).digest()).slice(0, 12);
/** Content fingerprint of the stored bytes (sha256, 96 bits). */
export const fingerprint = (data: Buffer) => b64u(createHash("sha256").update(data).digest()).slice(0, 16);

export function encodeCursor(c: Cursor): string {
  return b64u(Buffer.from(JSON.stringify({ v: 1, ...c }), "utf8"));
}

const RESTART = "Call preview_text again without `cursor` to start from the first page.";

/** Longest cursor accepted; real ones are about 100 characters. */
export const CURSOR_MAX_CHARS = 512;

/** Any cursor that is not exactly what preview_text issued (empty, wrong characters, too long, bad JSON) is preview-cursor-invalid. */
export function decodeCursor(cursor: string): Cursor {
  let o: any;
  if (cursor.length > 0 && cursor.length <= CURSOR_MAX_CHARS && /^[A-Za-z0-9_-]+$/.test(cursor)) {
    try { o = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { o = undefined; }
  }
  if (!o || o.v !== 1 || typeof o.k !== "string" || typeof o.h !== "string" || (o.u !== "cue" && o.u !== "line") || !Number.isSafeInteger(o.f) || o.f < 1
    || (o.m !== undefined && (!Number.isSafeInteger(o.m) || o.m < 1)))
    throw mcpError("preview-cursor-invalid", "`cursor` is not a cursor returned by preview_text.", `Pass the \`next\` value from the previous page unchanged. ${RESTART}`);
  return { k: o.k, h: o.h, u: o.u, f: o.f, ...(o.m !== undefined ? { m: o.m } : {}) };
}

/** The stored bytes differ from the ones the (well-formed, matching) cursor was issued for. */
export function sourceChanged() {
  return mcpError("preview-source-changed", "The file changed since the previous page was read, so the cursor no longer points into the same text.", RESTART);
}

/**
 * Checks a decoded cursor against the current source. preview-source-changed is only for a fingerprint mismatch;
 * a cursor for another file, or one whose unit or position can't have been issued for these bytes, is preview-cursor-invalid.
 */
export function checkCursor(c: Cursor, key: string, fp: string, s: Segments): void {
  if (c.k !== key) throw mcpError("preview-cursor-invalid", "`cursor` belongs to a different file (another job id, `which`, location or `fps`).", `Use a cursor only with the arguments it was returned for. ${RESTART}`);
  if (c.h !== fp) throw sourceChanged();
  if (c.u !== s.unit || c.f >= s.parts.length)
    throw mcpError("preview-cursor-invalid", "`cursor` does not point into this file's text (its unit or position was not issued by preview_text for these bytes).", `Pass the \`next\` value from the previous page unchanged. ${RESTART}`);
}

/** One summary sentence for a partial page, e.g. "Showing cues 1–402 of 5020 (65431 of 812004 bytes)." */
export function pageText(p: { unit: Unit; from: number; to: number; total: number; returnedBytes: number; totalBytes: number; truncated: boolean }): string {
  if (p.total === 0) return " The file is empty.";
  const all = p.from === 1 && !p.truncated;
  if (all) return ` Showing all ${p.total} ${p.unit}${p.total === 1 ? "" : "s"} (${p.totalBytes} bytes).`;
  return ` Showing ${p.unit}s ${p.from}–${p.to} of ${p.total} (${p.returnedBytes} of ${p.totalBytes} bytes).${p.truncated ? " MORE TEXT FOLLOWS: pass `next` as `cursor` to read the next page." : " This is the last page."}`;
}

/** Last path segment of an API location (bare path, file:, s3: or https: URI), decoded; undefined if none. */
export function locationBaseName(location: string): string | undefined {
  let pathname: string;
  if (location.startsWith("/")) pathname = location;
  else {
    try { pathname = new URL(location).pathname; } catch { return undefined; }
  }
  const last = pathname.split("/").pop();
  if (!last) return undefined;
  try { return decodeURIComponent(last); } catch { return last; }
}
