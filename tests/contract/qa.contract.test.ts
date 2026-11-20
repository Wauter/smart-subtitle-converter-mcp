/**
 * Broadcast Tester regressions (QA p7/p8) against the real API image, using API-side storage.
 * Gated on CONTRACT_API_URL and CONTRACT_API_STORAGE (a folder inside STORAGE_FILE_ROOTS on the API side,
 * e.g. /tmp in the contract containers). Files are read back through the API, never from the host disk.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { callTool, harness, type Harness } from "../helpers/harness.js";
import { longSrt, LONG_CUES } from "../helpers/fixtures.js";
import { probeApi } from "../../src/probe.js";

const URL_ = process.env.CONTRACT_API_URL?.replace(/\/+$/, "");
const KEY = process.env.CONTRACT_API_KEY || undefined;
const STORE = process.env.CONTRACT_API_STORAGE?.replace(/\/+$/, "");
const auth: Record<string, string> = KEY ? { authorization: `Bearer ${KEY}` } : {};
const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const ACCENTED = "1\n00:00:01,000 --> 00:00:02,500\nCafé déjà vu, naïve façade\n\n2\n00:00:03,000 --> 00:00:04,000\nÜber £5 — “quoted”\n";

describe.skipIf(!URL_ || !STORE)("contract: QA regressions on the real API", () => {
  let h: Harness;
  const stored = async (jobId: string, which = "output") => {
    const r = await fetch(`${URL_}/v1/jobs/${jobId}/${which}`, { headers: auth });
    expect(r.status, `GET job ${which}`).toBe(200);
    return Buffer.from(await r.arrayBuffer());
  };
  const direct = async (body: unknown) => {
    const r = await fetch(`${URL_}/v1/convert/json`, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body) });
    return (await r.json()) as any;
  };
  const resourceBytes = (r: any): Buffer => {
    const res = r.content.find((c: any) => c.type === "resource")?.resource;
    expect(res, "attached resource").toBeTruthy();
    return res.text !== undefined ? Buffer.from(res.text, "utf8") : Buffer.from(res.blob, "base64");
  };
  const walk = async (jobId: string, extra: Record<string, unknown> = {}) => {
    const pages: any[] = []; let cursor: string | undefined;
    do {
      const r = await callTool(h, "preview_text", { jobId, which: "output", ...extra, ...(cursor ? { cursor } : {}) });
      expect(r.isError, JSON.stringify(r.structuredContent?.error)).toBeFalsy();
      pages.push(r.structuredContent); cursor = r.structuredContent.next;
    } while (cursor);
    return pages;
  };
  beforeAll(async () => { h = await harness({ apiUrl: URL_!, apiKey: KEY }); await probeApi(h.deps.cfg, h.deps.log); });
  afterAll(async () => { await h.close(); });

  it("get_job reports a stored job, an inline job and a forgotten id from the real API", async () => {
    const out = `${STORE}/qa-${run}-job.vtt`;
    const s = await callTool(h, "convert_subtitle", { content: longSrt(20), fileName: "job.srt", target: "webvtt", output: out });
    expect(s.isError, JSON.stringify(s.structuredContent?.error)).toBeFalsy();
    const job = await callTool(h, "get_job", { jobId: s.structuredContent.jobId });
    expect(job.isError, JSON.stringify(job.structuredContent?.error)).toBeFalsy();
    expect(job.structuredContent).toMatchObject({ jobId: s.structuredContent.jobId, status: "succeeded", output: out });
    expect(job.structuredContent.outputs[0]).toMatchObject({ output: out, formatId: "webvtt" });
    expect(job.structuredContent.hint).toContain('which:"output"');
    const inline = await callTool(h, "convert_subtitle", { content: longSrt(5), fileName: "job.srt", target: "srt" });
    const inlineJob = await callTool(h, "get_job", { jobId: inline.structuredContent.jobId, wait: false });
    expect(inlineJob.structuredContent.status).toBe("succeeded");
    expect(inlineJob.structuredContent.hint).toContain("can't be recovered");
    const gone = await callTool(h, "get_job", { jobId: "00000000000000000000000000000000" });
    expect(gone.structuredContent.error.code).toBe("job-not-found");
  });

  it.each(["utf-8", "utf-8-no-bom", "utf-16", "utf-16le", "utf-16be", "windows-1252"])(
    "p7g/p8 item 1: %s inline resource is byte-identical to the direct API output and the stored output",
    async (encoding) => {
      const profile = { encoding: { output: encoding } };
      const inline = await callTool(h, "convert_subtitle", { content: ACCENTED, fileName: "a.srt", target: "srt", profile });
      expect(inline.isError, JSON.stringify(inline.structuredContent?.error)).toBeFalsy();
      const bytes = resourceBytes(inline);
      const res = inline.content.find((c: any) => c.type === "resource").resource;
      expect(res.text !== undefined).toBe(encoding.startsWith("utf-8")); // UTF-8 as text (BOM kept as U+FEFF), the rest as an exact blob
      expect(bytes.subarray(0, 3).equals(BOM)).toBe(encoding === "utf-8");
      expect(inline.structuredContent.outputs[0]).toMatchObject({ attached: true, bytes: bytes.length });

      const ref = await direct({ content: Buffer.from(ACCENTED).toString("base64"), contentEncoding: "base64", fileName: "a.srt", target: "srt", profile, responseEncoding: "base64" });
      expect(bytes.equals(Buffer.from(ref.outputs[0].content, "base64")), "inline vs direct API").toBe(true);

      const out = `${STORE}/qa-${run}-${encoding}.srt`;
      const s = await callTool(h, "convert_subtitle", { content: ACCENTED, fileName: "a.srt", target: "srt", profile, output: out });
      expect(s.isError, JSON.stringify(s.structuredContent?.error)).toBeFalsy();
      expect(s.structuredContent.outputs[0].fileName).toBe(`qa-${run}-${encoding}.srt`); // p8: fileName is the stored basename
      expect((await stored(s.structuredContent.jobId)).equals(bytes), "inline vs stored").toBe(true);

      const page = await callTool(h, "preview_text", { jobId: s.structuredContent.jobId, which: "output" });
      expect(page.isError, JSON.stringify(page.structuredContent?.error)).toBeFalsy();
      expect(page.structuredContent.text).toContain("Café déjà vu, naïve façade");
      expect(page.structuredContent.text.charCodeAt(0)).not.toBe(0xfeff);
    },
  );

  it.each([["srt", "srt"], ["webvtt", "vtt"]])("p7a/p8a: 1,569-cue %s output walks page by page and joins to the stored file without its BOM", async (target, ext) => {
    const out = `${STORE}/qa-${run}-long.${ext}`;
    const s = await callTool(h, "convert_subtitle", { content: longSrt(), fileName: "long.srt", target, output: out });
    expect(s.isError, JSON.stringify(s.structuredContent?.error)).toBeFalsy();
    const file = await stored(s.structuredContent.jobId);
    const body = (file.subarray(0, 3).equals(BOM) ? file.subarray(3) : file).toString("utf8");
    for (const maxBytes of [undefined, 4096]) {
      const pages = await walk(s.structuredContent.jobId, maxBytes ? { maxBytes } : {});
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.map((p) => p.text).join("")).toBe(body);
      expect(pages.at(-1).toCue).toBe(LONG_CUES); expect(pages[0].totalCues).toBe(LONG_CUES);
      for (const p of pages) { expect(p.unit).toBe("cue"); expect(p.returnedBytes).toBeLessThanOrEqual(p.maxBytes); expect(p.warnings).toEqual([]); }
    }
    const clamped = await callTool(h, "preview_text", { jobId: s.structuredContent.jobId, which: "output", maxBytes: 1 });
    expect(clamped.structuredContent.maxBytes).toBe(4096);
    expect(clamped.structuredContent.warnings).toEqual([expect.objectContaining({ code: "max-bytes-clamped", details: { fields: { requested: "1", applied: "4096" } } })]);
  });
});
