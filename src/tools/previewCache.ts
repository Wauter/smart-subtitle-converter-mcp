import type { WarningT } from "../errors.js";

/**
 * H7: preview_text's in-memory cache (never on disk). One entry per source (`key`: local real path, API location, or job
 * file) holds the text that is paged: the file's own text, or the SRT a binary file was converted to. Every use first
 * runs a cheap change check: a local file's device, inode, size and modification time; an API file's ETag (sent as
 * If-None-Match, 304 when unchanged). A different version is a miss and the file is read again. Bounded by a total size
 * cap (least recently used entries go first) and an idle time-to-live; an entry larger than the cap is not cached.
 */
export interface PreviewEntry {
  key: string;
  /** Change-check value: "fs:dev:ino:size:mtimeMs" or an API ETag. */
  version?: string;
  /** Fingerprint of the stored bytes (the cursor's `h`). */
  fp: string;
  text: string;
  /** Size of the stored file in bytes. */
  bytes: number;
  warnings: WarningT[];
  convertedFrom?: string;
  formatId?: string;
  mediaType: string;
  requestId?: string;
}

interface Slot { entry: PreviewEntry; size: number; usedAt: number }

export class PreviewCache {
  private slots = new Map<string, Slot>();
  private total = 0;
  hits = 0;
  misses = 0;
  evictions = 0;
  constructor(public readonly maxBytes: number, public readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  /** Approximate memory of an entry: UTF-16 text plus warnings and fixed overhead. */
  static sizeOf(e: PreviewEntry): number {
    return e.text.length * 2 + JSON.stringify(e.warnings).length * 2 + 512;
  }

  get size(): number { return this.total; }
  get count(): number { return this.slots.size; }

  private drop(key: string): void {
    const s = this.slots.get(key);
    if (!s) return;
    this.slots.delete(key);
    this.total -= s.size;
  }

  private expire(): void {
    const t = this.now();
    for (const [k, s] of this.slots) if (t - s.usedAt > this.ttlMs) this.drop(k);
  }

  /** The entry for `key` (any version), refreshed as most recently used; undefined after expiry. */
  peek(key: string): PreviewEntry | undefined {
    this.expire();
    const s = this.slots.get(key);
    if (!s) return undefined;
    s.usedAt = this.now();
    this.slots.delete(key);
    this.slots.set(key, s);
    return s.entry;
  }

  /** A hit only when the cached version equals the current one; a different version drops the entry. */
  get(key: string, version: string | undefined): PreviewEntry | undefined {
    const e = this.peek(key);
    if (e && version !== undefined && e.version === version) { this.hits++; return e; }
    if (e) this.drop(key);
    this.misses++;
    return undefined;
  }

  /** Counts a hit found by content (same fingerprint) after a full read. */
  hitByContent(): void { this.hits++; this.misses = Math.max(0, this.misses - 1); }

  set(e: PreviewEntry): boolean {
    if (this.maxBytes <= 0) return false;
    this.drop(e.key);
    const size = PreviewCache.sizeOf(e);
    if (size > this.maxBytes) return false;
    this.expire();
    while (this.total + size > this.maxBytes && this.slots.size) {
      const oldest = this.slots.keys().next().value as string;
      this.drop(oldest);
      this.evictions++;
    }
    this.slots.set(e.key, { entry: e, size, usedAt: this.now() });
    this.total += size;
    return true;
  }

  delete(key: string): void { this.drop(key); }
}
