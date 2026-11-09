/**
 * Browse and read by location against a real API. Gated on CONTRACT_API_URL and CONTRACT_API_STORAGE (a folder inside the
 * API's STORAGE_FILE_ROOTS). CONTRACT_API_LIST=1 means the API runs with STORAGE_LIST_ENABLED=true; the on-tests also skip
 * when the API doesn't report `storage.list` (an API image older than this feature).
 */
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
  let h: Harness, supported = false;
  beforeAll(async () => {
    const limits: any = await (await fetch(`${URL_}/v1/limits`, { headers: auth })).json();
    supported = typeof limits?.storage?.list === "boolean";
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
    expect((await callTool(h, "list_files", { location: "file:///etc/" })).structuredContent.error.code).toBe("storage-location-rejected");
    expect((await callTool(h, "preview_text", { location: "file:///etc/passwd" })).structuredContent.error.code).toBe("storage-location-rejected");
  });
});
