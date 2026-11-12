/**
 * Browse and read by location against a real API. Gated on CONTRACT_API_URL and CONTRACT_API_STORAGE (a folder inside the
 * API's STORAGE_FILE_ROOTS). CONTRACT_API_LIST=1 means the API runs with STORAGE_LIST_ENABLED=true; the on-tests also skip
 * when the API doesn't report `storage.list` (an API image older than this feature).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { callTool, harness, type Harness } from "../helpers/harness.js";
import { longSrt, LONG_CUES } from "../helpers/fixtures.js";
import { probeApi } from "../../src/probe.js";

const URL_ = process.env.CONTRACT_API_URL?.replace(/\/+$/, "");
const KEY = process.env.CONTRACT_API_KEY || undefined;
const STORE = process.env.CONTRACT_API_STORAGE?.replace(/\/+$/, "");
const LIST = process.env.CONTRACT_API_LIST === "1";
const auth: Record<string, string> = KEY ? { authorization: `Bearer ${KEY}` } : {};
const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!URL_ || !STORE)("contract: browse and read by location", () => {
  let h: Harness, supported = false, hardened = false, storageLimits: any;
  beforeAll(async () => {
    const limits: any = await (await fetch(`${URL_}/v1/limits`, { headers: auth })).json();
    supported = typeof limits?.storage?.list === "boolean";
    storageLimits = limits?.storage;
    hardened = Array.isArray(limits?.storage?.extensions); // API with the security hardening (hidden-path, extension-not-allowed, ETag)
    h = await harness({ apiUrl: URL_!, apiKey: KEY, listEnabled: true });
    await probeApi(h.deps.cfg, h.deps.log);
  });
  afterAll(async () => { await h.close(); });

  it("API off: remote is disabled-api, list_files and preview_text refuse API locations, the API answers 403 itself", async (ctx) => {
    if (LIST) ctx.skip();
    const folders = await callTool(h, "list_allowed_folders", {});
    expect(folders.structuredContent.remote.state).toBe("disabled-api");
    expect(folders.structuredContent.remote.locations).toEqual([]);
    expect(JSON.stringify(folders)).not.toContain(STORE!);
    expect((await callTool(h, "list_files", { location: `file://${STORE}/` })).structuredContent.error.code).toBe("storage-list-disabled");
    expect((await callTool(h, "preview_text", { location: `file://${STORE}/x.srt` })).structuredContent.error.code).toBe("storage-list-disabled");
    if (supported) {
      const r = await fetch(`${URL_}/v1/storage/list?location=${encodeURIComponent(`file://${STORE}/`)}`, { headers: auth });
      expect(r.status).toBe(403); expect(((await r.json()) as any).code).toBe("storage-list-disabled");
    }
  });

  it("API on: locations, a paged listing with prefix, and location previews that join to the stored file", async (ctx) => {
    if (!LIST || !supported) ctx.skip();
    const folders = await callTool(h, "list_allowed_folders", {});
    expect(folders.structuredContent.remote.state).toBe("on");
    expect(folders.structuredContent.remote.locations.map((l: any) => l.location)).toContain(`file://${STORE}/`);
    // 3 stored files written through conversions; the listing must find exactly these under the run prefix.
    const names = ["a.srt", "b.vtt", "c.stl"].map((n) => `qa-browse-${run}-${n}`);
    for (const [i, target] of ["srt", "webvtt", "ebustl"].entries()) {
      const r = await callTool(h, "convert_subtitle", { content: i === 0 ? longSrt() : longSrt(20), fileName: "src.srt", target, output: `${STORE}/${names[i]}` });
      expect(r.isError, JSON.stringify(r.structuredContent?.error)).toBeFalsy();
    }
    const list = await callTool(h, "list_files", { location: `file://${STORE}/`, prefix: `qa-browse-${run}-` });
    expect(list.isError, JSON.stringify(list.structuredContent?.error)).toBeFalsy();
    expect(list.structuredContent.items.map((i: any) => i.name)).toEqual(names);
    expect(list.structuredContent.truncated).toBe(false);
    const [srt, vtt, stl] = list.structuredContent.items;
    const stored = Buffer.from(await (await fetch(`${URL_}/v1/storage/file?location=${encodeURIComponent(srt.location)}`, { headers: auth })).arrayBuffer());
    expect(srt.size).toBe(stored.length);
    const body = (stored[0] === 0xef ? stored.subarray(3) : stored).toString("utf8");
    const pages: any[] = []; let cursor: string | undefined;
    do {
      const r = await callTool(h, "preview_text", { location: srt.location, maxBytes: 16384, ...(cursor ? { cursor } : {}) });
      expect(r.isError, JSON.stringify(r.structuredContent?.error)).toBeFalsy();
      pages.push(r.structuredContent); cursor = r.structuredContent.next;
    } while (cursor);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map((p) => p.text).join("")).toBe(body);
    expect(pages.at(-1).toCue).toBe(LONG_CUES);
    const v = await callTool(h, "preview_text", { location: vtt.location });
    expect(v.structuredContent.text.startsWith("WEBVTT")).toBe(true);
    const b = await callTool(h, "preview_text", { location: stl.location });
    expect(b.structuredContent).toMatchObject({ source: "remote", convertedTo: "srt" });
    expect(b.structuredContent.text).toContain("QA long programme cue 20");
    // Hidden files: never listed or read back by location or as a conversion input. A hardened API also refuses to write
    // them (hidden-path); older ones accepted the write and rejected the read as storage-location-rejected.
    const hidden = `.qa-browse-${run}-hidden.srt`;
    const hiddenCode = hardened ? "hidden-path" : "storage-location-rejected";
    const write = await callTool(h, "convert_subtitle", { content: longSrt(3), fileName: "src.srt", target: "srt", output: `${STORE}/${hidden}` });
    if (hardened) expect(write.structuredContent.error).toMatchObject({ code: "hidden-path" });
    else expect(write.isError).toBeFalsy();
    const all = await callTool(h, "list_files", { location: `file://${STORE}/` });
    expect(JSON.stringify(all.structuredContent)).not.toContain(hidden);
    for (const location of [`file://${STORE}/${hidden}`, `file://${STORE}/%2E${hidden.slice(1)}`]) {
      const r = await callTool(h, "preview_text", { location });
      expect(r.structuredContent.error).toMatchObject({ status: 422, code: hiddenCode });
    }
    expect((await callTool(h, "convert_subtitle", { input: `${STORE}/${hidden}`, target: "webvtt" })).structuredContent.error).toMatchObject({ status: 422, code: hiddenCode });
    expect((await callTool(h, "preview_text", { location: `${srt.location}%00.txt` })).structuredContent.error).toMatchObject({ status: 422, code: "storage-location-rejected" });
    expect((await callTool(h, "list_files", { location: "file:///etc/" })).structuredContent.error.code).toBe("storage-location-rejected");
    expect((await callTool(h, "preview_text", { location: "file:///etc/passwd" })).structuredContent.error.code).toBe("storage-location-rejected");
  });

  it("hardened API: extension allowlist on locations, ETag change checks feed the preview cache, browse limits reported", async (ctx) => {
    if (!LIST || !hardened) ctx.skip();
    const limits = storageLimits;
    expect(limits.extensions).toContain(".srt"); expect(limits.extensions).not.toContain(".pdf");
    expect(limits.listMaxEntries).toBeGreaterThan(0);
    expect(limits.browse).toMatchObject({ concurrency: expect.any(Number), queueCapacity: expect.any(Number) });
    const pdf = await callTool(h, "preview_text", { location: `file://${STORE}/qa-${run}-notes.pdf` });
    expect(pdf.structuredContent.error).toMatchObject({ code: "extension-not-allowed" });
    expect((await callTool(h, "convert_subtitle", { content: longSrt(3), fileName: "src.srt", target: "srt", output: `${STORE}/qa-${run}-out.pdf` })).structuredContent.error.code).toBe("extension-not-allowed");
    const name = `qa-etag-${run}.srt`;
    expect((await callTool(h, "convert_subtitle", { content: longSrt(5), fileName: "src.srt", target: "srt", output: `${STORE}/${name}` })).isError).toBeFalsy();
    const location = `file://${STORE}/${name}`;
    const first = await fetch(`${URL_}/v1/storage/file?location=${encodeURIComponent(location)}`, { headers: auth });
    const tag = first.headers.get("etag");
    expect(first.status).toBe(200); expect(tag).toMatch(/^"f-/);
    const again = await fetch(`${URL_}/v1/storage/file?location=${encodeURIComponent(location)}`, { headers: { ...auth, "if-none-match": tag! } });
    expect(again.status).toBe(304);
    const cache = h.deps.previewCache, hits = cache.hits;
    const a = await callTool(h, "preview_text", { location });
    const b = await callTool(h, "preview_text", { location });
    expect(b.structuredContent.text).toBe(a.structuredContent.text);
    expect(cache.hits).toBe(hits + 1);
    // Rewrite it (a different cue count): the change check misses and the new text comes back.
    expect((await callTool(h, "convert_subtitle", { content: longSrt(7), fileName: "src.srt", target: "srt", output: `${STORE}/${name}`, ifExists: "replace" })).isError).toBeFalsy();
    const c = await callTool(h, "preview_text", { location });
    expect(c.structuredContent.text).not.toBe(a.structuredContent.text);
    expect(c.structuredContent.toCue).toBe(7);
  });

  // Only when the test shares the API's filesystem (a local dev build): CONTRACT_STORAGE_ROOT is STORE seen from here.
  it.skipIf(!process.env.CONTRACT_STORAGE_ROOT)("hardened API never follows symlinks in listings, reads or writes", async (ctx) => {
    if (!LIST || !hardened) ctx.skip();
    const root = process.env.CONTRACT_STORAGE_ROOT!;
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "contract-outside-"));
    fs.writeFileSync(path.join(outsideDir, "secret.srt"), "SECRET_SENTINEL");
    fs.symlinkSync(path.join(outsideDir, "secret.srt"), path.join(root, `qa-link-${run}.srt`));
    fs.symlinkSync(outsideDir, path.join(root, `qa-linkdir-${run}`));
    try {
      const list = await callTool(h, "list_files", { location: `file://${STORE}/`, prefix: `qa-link` });
      expect(JSON.stringify(list.structuredContent)).not.toContain(run);
      for (const location of [`file://${STORE}/qa-link-${run}.srt`, `file://${STORE}/qa-linkdir-${run}/secret.srt`]) {
        const r = await callTool(h, "preview_text", { location });
        expect(r.isError, location).toBe(true);
        expect(JSON.stringify(r)).not.toContain("SECRET_SENTINEL");
      }
      const w = await callTool(h, "convert_subtitle", { content: longSrt(2), fileName: "src.srt", target: "srt", output: `${STORE}/qa-link-${run}.srt`, ifExists: "replace" });
      expect(w.isError).toBe(true);
      expect(fs.readFileSync(path.join(outsideDir, "secret.srt"), "utf8")).toBe("SECRET_SENTINEL");
    } finally { fs.rmSync(outsideDir, { recursive: true, force: true }); }
  });
});
