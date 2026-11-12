/** H7: the preview cache on its own, with a fake clock: LRU size cap, oversized entries, idle TTL, versions. */
import { describe, it, expect } from "vitest";
import { PreviewCache, type PreviewEntry } from "../../src/tools/previewCache.js";

const entry = (key: string, chars: number, version = "v1"): PreviewEntry => ({ key, version, fp: "fp-" + key, text: "x".repeat(chars), bytes: chars, warnings: [], mediaType: "application/x-subrip" });

describe("PreviewCache", () => {
  it("hit only for the same version; a different version is a miss and drops the entry", () => {
    const c = new PreviewCache(1 << 20, 60_000);
    c.set(entry("a", 100, "v1"));
    expect(c.get("a", "v1")?.text.length).toBe(100);
    expect(c.get("a", "v2")).toBeUndefined();
    expect(c.get("a", "v1")).toBeUndefined(); // dropped by the mismatch
    expect(c.get("a", undefined)).toBeUndefined(); // no version: never a hit
    expect([c.hits, c.misses]).toEqual([1, 3]);
  });

  it("never exceeds the size cap across many files, evicting least recently used first", () => {
    const max = 64 * 1024;
    const c = new PreviewCache(max, 60_000);
    for (let i = 0; i < 500; i++) {
      c.set(entry(`f${i}`, 1000 + (i % 7) * 900));
      expect(c.size).toBeLessThanOrEqual(max);
      if (i % 2 === 0) c.peek("f0"); // keep f0 recently used
    }
    expect(c.peek("f0")).toBeDefined();
    expect(c.peek("f1")).toBeUndefined();
    expect(c.evictions).toBeGreaterThan(0);
    expect(c.count).toBeGreaterThan(1);
  });

  it("an entry bigger than the cap is not cached and evicts nothing", () => {
    const c = new PreviewCache(10_000, 60_000);
    expect(c.set(entry("small", 100))).toBe(true);
    expect(c.set(entry("huge", 10_000))).toBe(false);
    expect(c.peek("huge")).toBeUndefined();
    expect(c.peek("small")).toBeDefined();
    expect(new PreviewCache(0, 60_000).set(entry("off", 1))).toBe(false); // cap 0 turns the cache off
  });

  it("drops entries idle for longer than the TTL; use refreshes them", () => {
    let now = 0;
    const c = new PreviewCache(1 << 20, 1000, () => now);
    c.set(entry("a", 10)); c.set(entry("b", 10));
    now = 900; expect(c.get("a", "v1")).toBeDefined();
    now = 1500; // b idle 1500 ms, a idle 600 ms
    expect(c.peek("b")).toBeUndefined();
    expect(c.peek("a")).toBeDefined();
    now = 3000; expect(c.peek("a")).toBeUndefined();
    expect(c.size).toBe(0);
  });
});
