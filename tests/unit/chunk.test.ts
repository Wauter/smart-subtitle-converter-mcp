import { describe, it, expect } from "vitest";
import { unzipSync } from "fflate";
import { chunkItems, estimateResponse, type ChunkCaps } from "../../src/batch/chunk.js";
import { buildZip, needsAlias, zipSizeUpperBound } from "../../src/batch/zip.js";
import { ambiguousGroups, stemOf } from "../../src/batch/select.js";
import { capsFrom } from "../../src/api/limits.js";
import { defaultConfig } from "../../src/config.js";

const caps = (o: Partial<ChunkCaps> = {}): ChunkCaps => ({
  maxEntries: 100, maxUnpacked: 50 * 1024 * 1024, maxZipBytes: 10_485_760, maxBody: 14_112_088, maxResponse: 64 * 1024 * 1024, profileBytes: 0, outputsPerEntry: 1, ...o,
});
const items = (n: number, size = 1000) => Array.from({ length: n }, (_, i) => ({ entryName: `f${String(i).padStart(3, "0")}.srt`, size }));

describe("chunker", () => {
  it("splits on the entry limit", () => {
    const r = chunkItems(items(250), caps());
    expect(r.chunks.map((c) => c.length)).toEqual([100, 100, 50]);
  });
  it("splits on unpacked bytes", () => {
    const r = chunkItems(items(10, 1000), caps({ maxUnpacked: 3500 }));
    expect(r.chunks.map((c) => c.length)).toEqual([3, 3, 3, 1]);
  });
  it("splits on the zip / JSON body caps", () => {
    const r = chunkItems(items(10, 100_000), caps({ maxZipBytes: 350_000 }));
    expect(r.chunks.every((c) => zipSizeUpperBound(c.map((i) => ({ name: i.entryName, size: i.size }))) <= 350_000)).toBe(true);
    const r2 = chunkItems(items(10, 100_000), caps({ maxBody: 4 * 100_000 }));
    expect(r2.chunks.length).toBeGreaterThan(3);
  });
  it("splits on the estimated response size, using outputsPerEntry", () => {
    const one = estimateResponse(items(1, 100_000), 1);
    expect(one).toBe(Math.ceil(100_000 * 1.5 * (4 / 3)) + 65536);
    const r1 = chunkItems(items(10, 100_000), caps({ maxResponse: 1_000_000 }));
    const r2 = chunkItems(items(10, 100_000), caps({ maxResponse: 1_000_000, outputsPerEntry: 2 }));
    expect(r2.chunks.length).toBeGreaterThan(r1.chunks.length);
  });
  it("a single oversized file is returned separately", () => {
    const r = chunkItems([{ entryName: "big.srt", size: 20_000_000 }, ...items(2)], caps());
    expect(r.oversized.map((i) => i.entryName)).toEqual(["big.srt"]);
    expect(r.chunks.flat().length).toBe(2);
  });
  it("fallback defaults when /v1/limits is unavailable", () => {
    const c = capsFrom({ kind: "unsupported" }, defaultConfig());
    expect([c.zipMaxEntries, c.zipMaxUnpacked, c.zipMaxEntryBytes, c.jsonDecoded, c.jsonBody]).toEqual([100, 52_428_800, 10_485_760, 10_485_760, 14_112_088]);
    const u = capsFrom({ kind: "unknown" }, defaultConfig({ batchMaxEntries: 7 }));
    expect([u.zipMaxEntries, u.jsonDecoded]).toEqual([7, 10_485_760]);
  });
});

describe("zip", () => {
  it("round-trips entries with subfolders", () => {
    const z = buildZip([{ name: "s1/a.srt", data: Buffer.from("x") }, { name: "b.srt", data: Buffer.from("y") }], 100);
    const files = unzipSync(z);
    expect(Object.keys(files).sort()).toEqual(["b.srt", "s1/a.srt"]);
  });
  it("stores highly compressible entries over 1 MB instead of deflating them", () => {
    const big = Buffer.alloc(2_000_000, 0x41);
    const z = buildZip([{ name: "big.srt", data: big }], 100);
    expect(z.length).toBeGreaterThan(2_000_000);
    const small = buildZip([{ name: "big.srt", data: big }], 100_000);
    expect(small.length).toBeLessThan(100_000);
  });
  it("aliases exactly the API's unsafe names (D-36) and top-level manifest.json", () => {
    for (const n of ["../x.srt", "s1/../x.srt", "s1/..", "/abs.srt", "back\\slash.srt", "C:x.srt", "ctl\u0001.srt", "manifest.json", "Manifest.JSON"]) expect(needsAlias(n)).toBe(true);
    for (const n of ["ok.srt", "a..b.srt", "s1/x..y.srt", "s1/manifest.json", "s1/e1.srt"]) expect(needsAlias(n)).toBe(false);
  });
});

describe("ambiguous names (D-29)", () => {
  it("groups by folder + stem, case-insensitive, NFC", () => {
    expect(stemOf("My Movie.en.srt")).toBe("My Movie.en");
    const g = ambiguousGroups([
      { source: "/in/s1/ep1.srt", entryName: "s1/ep1.srt" },
      { source: "/in/s1/EP1.vtt", entryName: "s1/EP1.vtt" },
      { source: "/in/s2/ep1.srt", entryName: "s2/ep1.srt" },
      { source: "/in/cafe\u0301.srt", entryName: "cafe\u0301.srt" },
      { source: "/in/caf\u00e9.vtt", entryName: "caf\u00e9.vtt" },
    ]);
    expect(g).toEqual([["/in/s1/ep1.srt", "/in/s1/EP1.vtt"], ["/in/cafe\u0301.srt", "/in/caf\u00e9.vtt"]]);
  });
});
