/**
 * Security hardening on the MCP side: H3 extension allowlist, H6 folder cap, H7 preview cache (local and API, change
 * checks, cursor semantics), H10 no-follow reads and writes, parallel preview_text/list_files, and browse-busy retries.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { API, EXTENSIONS, LIMITS, SRT, baseHandlers, callTool, convertOk, harness, mswServer, problem, recorded, tmpDir, type Harness } from "../helpers/harness.js";
import { fdPath, readFileChecked, realpathRoots } from "../../src/fs/guard.js";
import { LIST_MAX_ENTRIES } from "../../src/tools/storage.js";
import { apiInfo } from "../../src/api/info.js";

let h: Harness | undefined;
let dir: string, outside: string;
const limits = (extra: Record<string, unknown> = {}) => ({ ...LIMITS, storage: { extensions: EXTENSIONS, inputSchemes: ["file", "s3"], outputSchemes: ["file", "s3"], list: true, listSchemes: ["file", "s3"], ...extra } });
const mk = async (cfg: Record<string, unknown> = {}) => harness({ listEnabled: true, ...cfg }, { roots: await realpathRoots([dir], []) });
const code = (r: any) => r.structuredContent?.error?.code;
const cues = (n: number, word = "Line") => Array.from({ length: n }, (_, i) => `${i + 1}\n00:00:${String(i % 60).padStart(2, "0")},000 --> 00:00:${String(i % 60).padStart(2, "0")},500\n${word} ${i}\n`).join("\n");

beforeAll(() => mswServer.listen({ onUnhandledFrame: "error" })); afterAll(() => mswServer.close());
beforeEach(() => {
  recorded.length = 0; apiInfo.probedAt = Date.now(); mswServer.use(...baseHandlers());
  dir = tmpDir("mcp-hard-"); outside = tmpDir("mcp-hard-out-");
  fs.writeFileSync(path.join(dir, "a.srt"), SRT);
  fs.writeFileSync(path.join(outside, "secret.srt"), "SECRET_SENTINEL");
});
afterEach(async () => { await h?.close(); h = undefined; mswServer.resetHandlers(); for (const d of [dir, outside]) fs.rmSync(d, { recursive: true, force: true }); });

describe("H3 extension allowlist (local)", () => {
  it("non-subtitle files are never read or converted; the refusal is one short line without the list", async () => {
    fs.writeFileSync(path.join(dir, "notes.pdf"), "PDF"); fs.writeFileSync(path.join(dir, "README"), "x"); fs.writeFileSync(path.join(dir, "UPPER.SRT"), SRT);
    h = await mk();
    for (const p of [path.join(dir, "notes.pdf"), path.join(dir, "README"), path.join(dir, "missing.pdf")]) {
      for (const [tool, args] of [["preview_text", { location: p }], ["convert_subtitle", { path: p, target: "vtt" }], ["detect_format", { path: p }]] as const) {
        const r = await callTool(h, tool, args);
        expect(code(r), `${tool} ${p}`).toBe("extension-not-allowed");
        expect(r.structuredContent.error.hint).toBeUndefined();
        expect(r.structuredContent.error.detail).toBe(`${path.basename(p)} is not a subtitle file, so it isn't read.`);
      }
    }
    expect(recorded.filter((r) => r.path.startsWith("/v1/convert") || r.path.startsWith("/v1/detect"))).toEqual([]);
    expect((await callTool(h, "preview_text", { location: path.join(dir, "UPPER.SRT") })).isError).toBeFalsy(); // case-insensitive
    // Never shown to the model: no tool description carries the list.
    const tools = JSON.stringify((await h.client.listTools()).tools);
    for (const e of [".890", ".zeg", ".xsubtitle", ".cmft"]) expect(tools).not.toContain(e);
    // Order: outside the allowed folders first, then hidden, then the extension.
    expect(code(await callTool(h, "preview_text", { location: path.join(outside, "x.pdf") }))).toBe("path-not-allowed");
    expect(code(await callTool(h, "preview_text", { location: path.join(dir, ".x.pdf") }))).toBe("hidden-path");
  });

  it("uses the API's reported list", async () => {
    fs.writeFileSync(path.join(dir, "b.vtt"), "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n");
    mswServer.use(http.get(`${API}/v1/limits`, () => HttpResponse.json(limits({ extensions: [".srt"] }))));
    h = await mk();
    expect(code(await callTool(h, "preview_text", { location: path.join(dir, "b.vtt") }))).toBe("extension-not-allowed");
    expect((await callTool(h, "preview_text", { location: path.join(dir, "a.srt") })).isError).toBeFalsy();
    const names = (await callTool(h, "list_files", { location: dir })).structuredContent.items.map((i: any) => i.name);
    expect(names).toEqual(["a.srt"]);
  });

  it("an older API without a list: local reads, listings and writes go ahead unchecked, with a warning on the result", async () => {
    fs.writeFileSync(path.join(dir, "notes.pdf"), SRT);
    fs.writeFileSync(path.join(dir, ".hidden.srt"), SRT);
    fs.symlinkSync(path.join(dir, "a.srt"), path.join(dir, "link.srt"));
    mswServer.use(
      http.get(`${API}/v1/limits`, () => HttpResponse.json({ ...LIMITS, storage: { inputSchemes: ["file"] } })),
      http.post(`${API}/v1/convert/json`, () => HttpResponse.json(convertOk([{ fileName: "a.vtt", content: "WEBVTT\n", formatId: "webvtt" }]))),
    );
    h = await mk();
    const warned = (r: any) => {
      expect(r.isError, JSON.stringify(r.structuredContent?.error)).toBeFalsy();
      expect(r.content[0].text).toContain("Warning mcp-extension-check-skipped: Subtitle extension check skipped");
      expect(r.content[0].text).toMatch(/doesn't report its subtitle extensions.*update the API\./);
    };
    warned(await callTool(h, "preview_text", { location: path.join(dir, "notes.pdf") }));
    const list = await callTool(h, "list_files", { location: dir });
    warned(list);
    expect(list.structuredContent.items.map((i: any) => i.name)).toEqual(["a.srt", "notes.pdf"]); // hidden and links still left out
    const conv = await callTool(h, "convert_subtitle", { path: path.join(dir, "a.srt"), target: "vtt", outputPath: path.join(dir, "out.vtt") });
    warned(conv);
    expect(conv.structuredContent.warnings.map((w: any) => w.code)).toContain("mcp-extension-check-skipped");
    expect(fs.readFileSync(path.join(dir, "out.vtt"), "utf8")).toBe("WEBVTT\n");
    // The other rules still apply.
    expect(code(await callTool(h, "preview_text", { location: path.join(outside, "secret.srt") }))).toBe("path-not-allowed");
    expect(code(await callTool(h, "preview_text", { location: path.join(dir, ".hidden.srt") }))).toBe("hidden-path");
    expect(code(await callTool(h, "preview_text", { location: path.join(dir, "link.srt") }))).toBe("path-not-allowed");
    // Calls that touch no local file carry no such warning.
    const inline = await callTool(h, "convert_subtitle", { content: SRT, fileName: "x.srt", target: "vtt" });
    expect(inline.content[0].text).not.toContain("mcp-extension-check-skipped");
  });

  it("no /v1/limits at all also skips with the warning; an unreadable /v1/limits reports the real cause", async () => {
    mswServer.use(http.get(`${API}/v1/limits`, () => problem(404, "not-found")));
    h = await mk();
    const r = await callTool(h, "preview_text", { location: path.join(dir, "a.srt") });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("mcp-extension-check-skipped");
    await h.close();
    mswServer.use(http.get(`${API}/v1/limits`, () => problem(401, "unauthorized")));
    h = await mk();
    expect(code(await callTool(h, "preview_text", { location: path.join(dir, "a.srt") }))).toBe("unauthorized");
  });

  it("with the API's list there is no skipped-check warning", async () => {
    h = await mk();
    const r = await callTool(h, "preview_text", { location: path.join(dir, "a.srt") });
    expect(r.content[0].text).not.toContain("mcp-extension-check-skipped");
  });

  it("outputs: a non-subtitle name is refused before converting; an outputPath must use the produced format's extension", async () => {
    let posts = 0;
    mswServer.use(http.post(`${API}/v1/convert/json`, () => { posts++; return HttpResponse.json(convertOk([{ fileName: "a.vtt", content: "WEBVTT\n", formatId: "webvtt" }])); }));
    h = await mk();
    const pdf = await callTool(h, "convert_subtitle", { path: path.join(dir, "a.srt"), target: "vtt", outputPath: path.join(dir, "out.pdf") });
    expect(code(pdf)).toBe("extension-not-allowed"); expect(posts).toBe(0);
    const wrong = await callTool(h, "convert_subtitle", { path: path.join(dir, "a.srt"), target: "vtt", outputPath: path.join(dir, "out.srt") });
    expect(code(wrong)).toBe("extension-not-allowed"); expect(wrong.structuredContent.error.detail).toBe("out.srt doesn't match the output format; name it with .vtt.");
    expect(fs.existsSync(path.join(dir, "out.srt"))).toBe(false);
    const ok = await callTool(h, "convert_subtitle", { path: path.join(dir, "a.srt"), target: "vtt", outputPath: path.join(dir, "OUT.VTT") });
    expect(ok.isError, JSON.stringify(ok.structuredContent?.error)).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, "OUT.VTT"), "utf8")).toBe("WEBVTT\n");
  });
});

describe("H6 local folder cap", () => {
  it(`a folder with more than ${LIST_MAX_ENTRIES} matching entries is folder-too-large; a narrower prefix lists`, async () => {
    for (let i = 0; i <= LIST_MAX_ENTRIES; i++) fs.writeFileSync(path.join(dir, `ep${String(i).padStart(5, "0")}.srt`), "");
    h = await mk();
    const r = await callTool(h, "list_files", { location: dir });
    expect(code(r)).toBe("folder-too-large");
    expect(r.structuredContent.error.limit).toMatchObject({ name: "listMaxEntries", value: LIST_MAX_ENTRIES });
    expect(code(await callTool(h, "list_files", { location: dir, prefix: "ep" }))).toBe("folder-too-large");
    const narrow = await callTool(h, "list_files", { location: dir, prefix: "ep0000" });
    expect(narrow.structuredContent.items.map((i: any) => i.name)).toEqual(Array.from({ length: 10 }, (_, i) => `ep0000${i}.srt`));
  });
});

describe("H10 never follow symlinks (local)", () => {
  it("reads: O_NOFOLLOW refuses a final symlink, a FIFO never blocks, and the opened fd must be the checked file", async () => {
    fs.symlinkSync(path.join(outside, "secret.srt"), path.join(dir, "link.srt"));
    await expect(readFileChecked(path.join(dir, "link.srt"), "/x/link.srt")).rejects.toMatchObject({ toolError: { code: "path-not-allowed" } });
    if (process.platform !== "win32") {
      execFileSync("mkfifo", [path.join(dir, "pipe.srt")]);
      await expect(readFileChecked(path.join(dir, "pipe.srt"), "/x/pipe.srt")).rejects.toMatchObject({ toolError: { code: "not-a-file" } });
      h = await mk();
      expect(code(await callTool(h, "preview_text", { location: path.join(dir, "pipe.srt") }))).toBe("not-a-file");
    }
    const real = fdPath.of;
    try {
      fdPath.of = async () => path.join(outside, "secret.srt"); // the fd turned out to be another file (a swapped folder)
      await expect(readFileChecked(path.join(dir, "a.srt"), "/x/a.srt")).rejects.toMatchObject({ toolError: { code: "path-not-allowed" } });
      fdPath.of = async () => undefined; // platforms without /proc/self/fd: device + inode fallback
      expect((await readFileChecked(path.join(dir, "a.srt"), "/x/a.srt")).toString()).toBe(SRT);
    } finally { fdPath.of = real; }
  });

  it("symlinked files and folders inside an allowed folder are refused for reads, lists and writes; nothing outside changes", async () => {
    fs.mkdirSync(path.join(dir, "real")); fs.writeFileSync(path.join(dir, "real", "x.srt"), SRT);
    fs.symlinkSync(path.join(dir, "real"), path.join(dir, "linkdir"));
    fs.symlinkSync(path.join(dir, "a.srt"), path.join(dir, "inside-link.srt"));
    fs.symlinkSync(path.join(outside, "secret.srt"), path.join(dir, "victim.vtt"));
    mswServer.use(http.post(`${API}/v1/convert/json`, () => HttpResponse.json(convertOk([{ fileName: "a.vtt", content: "WEBVTT\n" }]))));
    h = await mk();
    for (const location of [path.join(dir, "inside-link.srt"), path.join(dir, "linkdir", "x.srt")])
      expect(code(await callTool(h, "preview_text", { location })), location).toBe("path-not-allowed");
    expect(code(await callTool(h, "list_files", { location: path.join(dir, "linkdir") }))).toBe("path-not-allowed");
    expect(code(await callTool(h, "convert_subtitle", { path: path.join(dir, "a.srt"), target: "vtt", outputDir: path.join(dir, "linkdir") }))).toBe("path-not-allowed");
    const replace = await callTool(h, "convert_subtitle", { path: path.join(dir, "a.srt"), target: "vtt", outputPath: path.join(dir, "victim.vtt"), ifExists: "replace" });
    expect(code(replace)).toBe("path-not-allowed");
    expect(fs.readFileSync(path.join(outside, "secret.srt"), "utf8")).toBe("SECRET_SENTINEL");
    expect(fs.lstatSync(path.join(dir, "victim.vtt")).isSymbolicLink()).toBe(true);
    expect(JSON.stringify(await callTool(h, "list_files", { location: dir }))).not.toContain("inside-link");
  });
});

describe("H7 preview cache", () => {
  it("local: a second read is a hit without opening the file; a change invalidates; the cursor still detects changes", async () => {
    const file = path.join(dir, "long.srt");
    fs.writeFileSync(file, cues(400));
    h = await mk();
    const first = await callTool(h, "preview_text", { location: file, maxBytes: 2048 });
    expect(first.structuredContent.truncated).toBe(true);
    const c = h.deps.previewCache;
    expect([c.hits, c.misses]).toEqual([0, 1]);
    const again = await callTool(h, "preview_text", { location: file, maxBytes: 2048, cursor: first.structuredContent.next });
    expect(again.isError, JSON.stringify(again.structuredContent?.error)).toBeFalsy();
    expect(again.structuredContent.fromCue).toBe(first.structuredContent.toCue + 1);
    expect(c.hits).toBe(1);
    // Change the file (size and mtime): the next page is a miss, the file is re-read and the cursor says it changed.
    fs.writeFileSync(file, cues(401, "Changed"));
    const changed = await callTool(h, "preview_text", { location: file, maxBytes: 2048, cursor: again.structuredContent.next });
    expect(code(changed)).toBe("preview-source-changed");
    const fresh = await callTool(h, "preview_text", { location: file, maxBytes: 2048 });
    expect(fresh.structuredContent.text).toContain("Changed 0");
    expect(c.misses).toBe(3);
  });

  it("local: the size cap is never exceeded across many files, and an oversized text is not cached", async () => {
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(dir, `f${i}.srt`), cues(60, `F${i}`));
    h = await mk({ previewCacheBytes: 40_000 });
    const c = h.deps.previewCache;
    for (let i = 0; i < 40; i++) {
      const r = await callTool(h, "preview_text", { location: path.join(dir, `f${i}.srt`) });
      expect(r.structuredContent.text).toContain(`F${i} 0`);
      expect(c.size).toBeLessThanOrEqual(40_000);
    }
    expect(c.evictions).toBeGreaterThan(0);
    fs.writeFileSync(path.join(dir, "big.srt"), cues(2000)); // ~140 KB of text: larger than the whole cache
    const before = { misses: c.misses, size: c.size, count: c.count };
    expect((await callTool(h, "preview_text", { location: path.join(dir, "big.srt") })).isError).toBeFalsy();
    expect((await callTool(h, "preview_text", { location: path.join(dir, "big.srt") })).isError).toBeFalsy();
    expect(c.misses).toBe(before.misses + 2); // never cached, so never a hit
    expect([c.size, c.count]).toEqual([before.size, before.count]); // and it evicted nothing
  });

  it("API location: If-None-Match with the cached ETag; 304 serves the cache, a binary file is converted to SRT once", async () => {
    let version = 1, posts = 0;
    const conditions: (string | null)[] = [];
    const pac = Buffer.from([0x14, 0x00, 0x00, 0x01, 0x02, 0x03, 0x00, 0x00]);
    mswServer.use(
      http.get(`${API}/v1/limits`, () => HttpResponse.json(limits())),
      http.get(`${API}/v1/storage/file`, ({ request }) => {
        const inm = request.headers.get("if-none-match"); conditions.push(inm);
        const tag = `"s3-v${version}"`;
        if (inm === tag) return new HttpResponse(null, { status: 304, headers: { ETag: tag } });
        return new HttpResponse(pac, { headers: { "Content-Type": "application/octet-stream", ETag: tag } });
      }),
      http.post(`${API}/v1/convert/json`, () => { posts++; return HttpResponse.json(convertOk([{ fileName: "show.srt", content: version === 1 ? SRT : SRT.replace("Hello", "Hallo"), formatId: "subrip" }], { detected: { id: "pac", kind: "binary" } })); }),
    );
    h = await mk();
    const location = "s3://subs/in/show.pac";
    const a = await callTool(h, "preview_text", { location });
    expect(a.isError, JSON.stringify(a.structuredContent?.error)).toBeFalsy();
    const b = await callTool(h, "preview_text", { location });
    expect(b.structuredContent.text).toBe(a.structuredContent.text);
    expect(b.structuredContent.convertedFrom).toBe(a.structuredContent.convertedFrom);
    expect(posts).toBe(1);
    expect(conditions).toEqual([null, '"s3-v1"']);
    version = 2;
    const c = await callTool(h, "preview_text", { location });
    expect(c.structuredContent.text).toContain("Hallo");
    expect(posts).toBe(2);
  });

  it("job files use the same change check", async () => {
    let gets = 0;
    const job = { id: "j1", status: "succeeded", input: "s3://subs/in/a.srt", output: "s3://subs/out/a.vtt", result: { detected: { id: "subrip", kind: "text", encoding: "utf-8" } } };
    mswServer.use(
      http.get(`${API}/v1/jobs/j1`, () => HttpResponse.json(job)),
      http.get(`${API}/v1/jobs/j1/input`, ({ request }) => { gets++; return request.headers.get("if-none-match") === '"t1"' ? new HttpResponse(null, { status: 304, headers: { ETag: '"t1"' } }) : new HttpResponse(SRT, { headers: { "Content-Type": "application/x-subrip", ETag: '"t1"' } }); }),
    );
    h = await mk();
    const a = await callTool(h, "preview_text", { jobId: "j1", which: "input" });
    const b = await callTool(h, "preview_text", { jobId: "j1", which: "input" });
    expect(b.structuredContent.text).toBe(a.structuredContent.text);
    expect(b.structuredContent.bytes).toBe(Buffer.byteLength(SRT));
    expect(gets).toBe(2);
    expect(h.deps.previewCache.hits).toBe(1);
  });
});

describe("parallel calls and the API browse queue", () => {
  it("20 parallel preview_text and list_files calls each get their own correct result", async () => {
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, `p${i}.srt`), cues(5, `P${i}`));
    for (let i = 0; i < 5; i++) { fs.mkdirSync(path.join(dir, `d${i}`)); fs.writeFileSync(path.join(dir, `d${i}`, `in${i}.srt`), SRT); }
    h = await mk();
    const calls = [
      ...Array.from({ length: 10 }, (_, i) => callTool(h!, "preview_text", { location: path.join(dir, `p${i}.srt`) }).then((r) => ({ i, kind: "preview", r }))),
      ...Array.from({ length: 5 }, (_, i) => callTool(h!, "list_files", { location: path.join(dir, `d${i}`) }).then((r) => ({ i, kind: "list", r }))),
      ...Array.from({ length: 5 }, (_, i) => callTool(h!, "preview_text", { location: path.join(dir, `p${i}.srt`) }).then((r) => ({ i, kind: "preview", r }))),
    ];
    for (const { i, kind, r } of await Promise.all(calls)) {
      expect(r.isError, JSON.stringify(r.structuredContent?.error)).toBeFalsy();
      if (kind === "preview") { expect(r.structuredContent.text).toContain(`P${i} 0`); expect(r.structuredContent.text).not.toMatch(new RegExp(`P(?!${i} )\\d`)); }
      else expect(r.structuredContent.items.map((x: any) => x.name)).toEqual([`in${i}.srt`]);
    }
  });

  it("browse-busy with Retry-After is retried like queue-full (preview_text and list_files), and reported when retries run out", async () => {
    let fileCalls = 0, listCalls = 0;
    mswServer.use(
      http.get(`${API}/v1/limits`, () => HttpResponse.json(limits())),
      http.get(`${API}/v1/storage/file`, () => (++fileCalls <= 2 ? problem(503, "browse-busy", {}, { "Retry-After": "0" }) : new HttpResponse(SRT, { headers: { "Content-Type": "application/x-subrip" } }))),
      http.get(`${API}/v1/storage/list`, () => (++listCalls <= 1 ? problem(503, "browse-busy", {}, { "Retry-After": "0" }) : HttpResponse.json({ location: "s3://subs/in/", items: [{ name: "a.srt", uri: "s3://subs/in/a.srt", type: "file", size: 1 }], truncated: false }))),
    );
    const progress: string[] = [];
    h = await mk();
    const r = await callTool(h, "preview_text", { location: "s3://subs/in/a.srt" }, { progress: (m) => progress.push(m) });
    expect(r.isError, JSON.stringify(r.structuredContent?.error)).toBeFalsy();
    expect(r.structuredContent.text).toBe(SRT);
    expect(fileCalls).toBe(3);
    const l = await callTool(h, "list_files", { location: "s3://subs/in/" });
    expect(l.structuredContent.items.map((i: any) => i.name)).toEqual(["a.srt"]);
    expect(listCalls).toBe(2);
    mswServer.use(http.get(`${API}/v1/storage/file`, () => problem(503, "browse-busy", {}, { "Retry-After": "0" })));
    const busy = await callTool(h, "preview_text", { location: "s3://subs/in/b.srt" });
    expect(busy.structuredContent.error).toMatchObject({ source: "api", status: 503, code: "browse-busy", retryAfterSeconds: 0 });
    expect(busy.structuredContent.error.hint).toContain("Retry-After");
  });
});
