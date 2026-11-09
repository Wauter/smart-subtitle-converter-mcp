/**
 * Regression tests for Broadcast Tester findings (QA rounds p6b, p7, p8). Each test names the finding it pins.
 * Mocked API here; the same behaviours against the real API image are in tests/contract.
 */
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { Ajv } from "ajv";
import { API, SRT, baseHandlers, callTool, harness, mswServer, recorded, convertOk, problem, type Harness } from "../helpers/harness.js";
import { longSrt, longVtt, occurrences, probe, LONG_CUES } from "../helpers/fixtures.js";
import { apiInfo } from "../../src/api/info.js";

let h: Harness | undefined;
const id = "ab0123456789abcdef0123456789abcdef";
const endpoint = `${API}/v1/jobs/${id}`;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const job = (over: any = {}) => ({ id, status: "succeeded", input: "s3://subs/in/long.srt", output: "s3://subs/out/long.srt", result: { detected: { encoding: "utf-8", id: "subrip", kind: "text" }, outputs: [{ encoding: "utf-8", formatId: "subrip", kind: "text" }] }, ...over });
beforeAll(() => mswServer.listen({ onUnhandledFrame: "error" })); afterAll(() => mswServer.close());
beforeEach(() => { recorded.length = 0; apiInfo.probedAt = Date.now(); mswServer.use(...baseHandlers()); });
afterEach(async () => { await h?.close(); h = undefined; mswServer.resetHandlers(); });

/** Serves `bytes` as the job's stored input and output (a getter, so tests can change the file between pages). */
function serve(bytes: () => Buffer, over: any = {}) {
  mswServer.use(http.get(endpoint, () => HttpResponse.json(job(over))),
    http.get(`${endpoint}/output`, () => new HttpResponse(bytes(), { headers: { "content-type": "application/x-subrip" } })),
    http.get(`${endpoint}/input`, () => new HttpResponse(bytes(), { headers: { "content-type": "application/x-subrip" } })));
}

/** Walks every page; returns the raw JSON-RPC results and structured pages. */
async function walk(args: Record<string, unknown>) {
  const raws: any[] = []; let cursor: string | undefined;
  do {
    const r = await callTool(h!, "preview_text", { ...args, ...(cursor ? { cursor } : {}) });
    expect(r.isError, JSON.stringify(r.structuredContent?.error)).toBeFalsy();
    raws.push(r); cursor = r.structuredContent.next;
  } while (cursor);
  return raws;
}

describe("QA p7/p8: long-file paging (1,569-cue fixture)", () => {
  it.each([["default page", undefined], ["4096-byte pages", 4096], ["262144-byte page", 262144]] as const)("p7a/p8a: %s walk joins to exactly the stored file without its BOM", async (_n, maxBytes) => {
    h = await harness(); const text = longSrt(); serve(() => Buffer.concat([BOM, Buffer.from(text)]));
    const pages = (await walk({ jobId: id, which: "output", ...(maxBytes ? { maxBytes } : {}) })).map((r) => r.structuredContent);
    expect(pages.map((p) => p.text).join("")).toBe(text);
    const size = Buffer.byteLength(text), page = maxBytes ?? 65536;
    expect(size).toBeGreaterThan(120_000); // the tester's ~120 KB programme
    expect(pages.length).toBeGreaterThanOrEqual(Math.ceil(size / page)); expect(pages.length).toBeLessThanOrEqual(Math.ceil(size / page) + 1);
    for (const [i, p] of pages.entries()) {
      expect(p).toMatchObject({ unit: "cue", totalCues: LONG_CUES, totalBytes: Buffer.byteLength(text), truncated: i < pages.length - 1 });
      expect(p.returnedBytes).toBe(Buffer.byteLength(p.text)); expect(p.returnedBytes).toBeLessThanOrEqual(p.maxBytes);
      expect(p.text.endsWith("\n\n")).toBe(true); expect(p.text).toMatch(/^\d+\n\d\d:\d\d:\d\d,\d{3} --> /);
      expect(p.fromCue).toBe(i === 0 ? 1 : pages[i - 1].toCue + 1); expect(p.returnedCues).toBe(p.toCue - p.fromCue + 1);
      expect(p.text.charCodeAt(0)).not.toBe(0xfeff);
    }
    expect(pages.at(-1).toCue).toBe(LONG_CUES);
  });
  it("p7a: default 64 KB pages split the long fixture at a whole cue with the counts the tester saw", async () => {
    h = await harness(); const text = longSrt(); serve(() => Buffer.from(text));
    const [p1, p2] = (await walk({ jobId: id, which: "input" })).map((r) => r.structuredContent);
    expect(p1.returnedBytes).toBeLessThanOrEqual(65536); expect(p1.returnedBytes + Buffer.byteLength(text.split("\n\n")[p1.toCue] + "\n\n")).toBeGreaterThan(65536);
    expect(p2.fromCue).toBe(p1.toCue + 1);
  });
  it("p7a: CRLF WebVTT with header and NOTE pages on whole cues and joins exactly", async () => {
    h = await harness(); const text = longVtt(LONG_CUES, "\r\n"); serve(() => Buffer.from(text), { output: "s3://subs/out/long.vtt", result: { outputs: [{ encoding: "utf-8-no-bom", formatId: "webvtt", kind: "text" }] } });
    const pages = (await walk({ jobId: id, which: "output", maxBytes: 4096 })).map((r) => r.structuredContent);
    expect(pages.map((p) => p.text).join("")).toBe(text);
    expect(pages[0].text.startsWith("WEBVTT\r\n\r\nNOTE generated QA fixture\r\n\r\n00:00:02.000 --> ")).toBe(true);
    for (const p of pages.slice(1)) expect(p.text).toMatch(/^\d\d:\d\d:\d\d\.\d{3} --> /);
    for (const p of pages) expect(p.text.endsWith("\r\n\r\n")).toBe(true);
    expect(pages[0]).toMatchObject({ unit: "cue", fromCue: 1, totalCues: LONG_CUES });
  });
  it("p6b/p7i: preview text is sent once per page and the response stays close to the text size", async () => {
    h = await harness(); const text = longSrt(); serve(() => Buffer.from(text));
    let seen = 0;
    for (const r of await walk({ jobId: id, which: "output" })) {
      const raw = JSON.stringify(r);
      expect(r.content).toHaveLength(1); expect(r.content[0].type).toBe("text");
      expect(r.content[0].text).not.toContain(probe(1));
      const inPage = occurrences(r.structuredContent.text, probe(1234) + "\n");
      expect(occurrences(raw, probe(1234) + "\\n")).toBe(inPage); seen += inPage;
      // JSON escaping adds about one byte per line; the old duplicate-content shape was about twice the text.
      expect(raw.length).toBeLessThan(r.structuredContent.returnedBytes * 1.15 + 4096);
    }
    expect(seen).toBe(1);
  });
});

describe("QA p7e/p8 item 4: cursor errors", () => {
  const forge = (o: object) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  const decode = (c: string) => JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
  it("every malformed or foreign cursor is preview-cursor-invalid, before or after fetching", async () => {
    h = await harness(); const text = longSrt(200); serve(() => Buffer.from(text));
    const next = (await callTool(h, "preview_text", { jobId: id, which: "output", maxBytes: 4096 })).structuredContent.next as string;
    const c = decode(next);
    const flipped = next.slice(0, 10) + (next[10] === "A" ? "B" : "A") + next.slice(11);
    const variants: Record<string, string> = {
      empty: "", spaces: "has spaces", plus: next + "+", padded: next + "=", tooLong: "x".repeat(600), truncated: next.slice(0, -4), half: next.slice(0, next.length >> 1),
      random: "Zm9vYmFy", randomChars: "_-_-_-", flipped,
      forgedZero: forge({ ...c, f: 0 }), forgedPastEnd: forge({ ...c, f: 10_000 }), forgedUnit: forge({ ...c, u: "line" }), forgedVersion: forge({ ...c, v: 2 }),
      otherJob: forge({ ...c, k: "aaaaaaaaaaaa" }),
    };
    for (const [name, cursor] of Object.entries(variants)) {
      const e = (await callTool(h, "preview_text", { jobId: id, which: "output", cursor })).structuredContent.error;
      expect(e?.code, name).toBe("preview-cursor-invalid");
    }
    expect((await callTool(h, "preview_text", { jobId: id, which: "input", cursor: next })).structuredContent.error.code).toBe("preview-cursor-invalid");
  });
  it("preview-source-changed only on a real change; restoring the bytes makes the cursor valid again", async () => {
    h = await harness(); const original = Buffer.from(longSrt(200)); let bytes = original; serve(() => bytes);
    const next = (await callTool(h, "preview_text", { jobId: id, which: "output", maxBytes: 4096 })).structuredContent.next as string;
    expect((await callTool(h, "preview_text", { jobId: id, which: "output", cursor: next })).isError).toBeFalsy(); // unchanged
    for (const changed of [Buffer.from(longSrt(200).replace("cue 7\n", "cue 7!\n")), Buffer.from(longSrt(150)), Buffer.concat([BOM, original])]) {
      bytes = changed;
      expect((await callTool(h, "preview_text", { jobId: id, which: "output", cursor: next })).structuredContent.error.code).toBe("preview-source-changed");
    }
    bytes = original;
    const again = await callTool(h, "preview_text", { jobId: id, which: "output", cursor: next });
    expect(again.isError).toBeFalsy(); expect(again.structuredContent.fromCue).toBeGreaterThan(1);
  });
});

describe("QA p7c/p8 item 3: oversized cues", () => {
  it("a cue over maxBytes comes alone and the walk continues; one over the server maximum is preview-cue-too-large with the location", async () => {
    h = await harness(); const big = `2\n00:00:02,000 --> 00:00:03,000\n${"x".repeat(110_000)}\n\n`;
    let text = longSrt(1) + big + "3\n00:00:04,000 --> 00:00:05,000\nafter\n"; serve(() => Buffer.from(text));
    const pages = (await walk({ jobId: id, which: "input", maxBytes: 4096 })).map((r) => r.structuredContent);
    expect(pages.map((p) => p.returnedCues)).toEqual([1, 1, 1]); expect(pages[1].text).toBe(big); expect(pages.map((p) => p.text).join("")).toBe(text);
    text = longSrt(1) + big.replace("x".repeat(110_000), "y".repeat(300_000));
    const first = (await callTool(h, "preview_text", { jobId: id, which: "input" })).structuredContent;
    const e = (await callTool(h, "preview_text", { jobId: id, which: "input", cursor: first.next })).structuredContent.error;
    expect(e).toMatchObject({ code: "preview-cue-too-large", location: "s3://subs/in/long.srt", limit: { name: "SUBTITLE_MCP_PREVIEW_MAX_BYTES", value: 262144 } });
    expect(e.hint).toContain("up to 1048576"); expect(e.hint).not.toMatch(/convert/i);
  });
});

describe("QA p7b/p8 item 2: maxBytes clamp", () => {
  it.each([[1, 4096], [100, 4096], [4095, 4096], [262145, 262144], [2_000_000, 262144]])("maxBytes %i is clamped to %i with a max-bytes-clamped warning on every page", async (requested, applied) => {
    h = await harness(); serve(() => Buffer.from(longSrt(400)));
    const pages = (await walk({ jobId: id, which: "output", maxBytes: requested })).map((r) => r.structuredContent);
    for (const p of pages) {
      expect(p.maxBytes).toBe(applied);
      expect(p.warnings).toEqual([expect.objectContaining({ code: "max-bytes-clamped", details: { fields: { requested: String(requested), applied: String(applied) } } })]);
    }
  });
  it.each([4096, 65536, 262144])("maxBytes %i is in range: no warning", async (maxBytes) => {
    h = await harness(); serve(() => Buffer.from(longSrt(50)));
    expect((await callTool(h, "preview_text", { jobId: id, which: "output", maxBytes })).structuredContent.warnings).toEqual([]);
  });
});

describe("QA p7g/p8 item 1: inline convert resources", () => {
  it("p7i: a long inline SRT is attached once, whole, with the BOM, and the response stays close to the file size", async () => {
    h = await harness(); const file = Buffer.concat([BOM, Buffer.from(longSrt())]);
    mswServer.use(http.post(`${API}/v1/convert/json`, () => HttpResponse.json({ id, ...convertOk([{ fileName: "long.srt", content: file.toString("base64"), contentEncoding: "base64", formatId: "subrip", encoding: "utf-8", bytes: file.length } as any]) })));
    const r = await callTool(h, "convert_subtitle", { content: SRT, target: "srt" });
    const raw = JSON.stringify(r);
    expect(r.content).toHaveLength(2); expect(Buffer.from(r.content[1].resource.text, "utf8").equals(file)).toBe(true);
    expect(r.structuredContent.outputs[0]).toMatchObject({ bytes: file.length, contentEncoding: "text", attached: true });
    expect(occurrences(raw, probe(1234) + "\\n")).toBe(1); expect(raw.length).toBeLessThan(file.length * 1.15 + 4096);
  });
});

describe("QA p6b/p7j: every tool result validates against its advertised outputSchema (ajv)", () => {
  it("success and error results of all tools", async () => {
    h = await harness();
    const stl = Buffer.from("850STL25.01\0binary");
    mswServer.use(
      http.get(`${API}/v1/profiles`, () => HttpResponse.json({ profiles: [{ name: "p", origin: "builtin", path: null, valid: true, description: null, target: "webvtt", loadedAt: "x", shadows: null, errors: null, warnings: null }], profilesDir: null, mountError: null })),
      http.get(`${API}/v1/profiles/:name`, ({ params }) => params.name === "p" ? HttpResponse.json({ name: "p", origin: "builtin", path: null, valid: true, description: null, target: "webvtt", loadedAt: "x", shadows: null, errors: [], warnings: [], raw: {}, resolved: {} }) : problem(404, "preset-not-found")),
      http.post(`${API}/v1/profiles/validate`, () => HttpResponse.json({ valid: false, errors: [{ pointer: "/target", message: "bad" }], warnings: [{ pointer: "/x", message: "w" }], resolved: null })),
      http.post(`${API}/v1/detect`, () => HttpResponse.json({ format: "SubRip", id: "subrip", encoding: "utf-8", encodingConfidence: "bom", paragraphs: 1, kind: "text", bom: true, lineEndings: "lf", warnings: [] })),
      http.post(`${API}/v1/convert/json`, async ({ request }) => {
        const b: any = await request.json();
        if (b.target === "bad") return problem(422, "ambiguous-encoding", { candidates: [{ encoding: "windows-1253", language: "el", hits: 21, sample: "Καλημέρα" }], probe: "text-encoding" });
        if (b.target === "ebustl") return HttpResponse.json({ id, ...convertOk([{ fileName: "a.stl", content: stl.toString("base64"), contentEncoding: "base64", formatId: "ebustl", kind: "binary", verification: { verdict: "lossless" } } as any]) });
        return HttpResponse.json({ id, ...convertOk([{ fileName: "a.srt", content: "1\n00:00:01,000 --> 00:00:02,000\nHi\n", formatId: "subrip", ...(b.output ? { output: b.output } : {}) }], { warnings: [{ code: "frame-rate-assumed", message: "m", details: { frameRate: 25 } }] }) });
      }),
    );
    serve(() => Buffer.from(longSrt(30)));
    const tools = (await h.client.listTools()).tools;
    const ajv = new Ajv({ strict: false, allErrors: true });
    const calls: [string, Record<string, unknown>][] = [
      ["list_formats", {}], ["list_presets", {}], ["get_profile", { name: "p" }], ["get_profile", { name: "missing" }],
      ["validate_profile", { profile: {} }], ["detect_format", { content: SRT }], ["detect_format", {}],
      ["convert_subtitle", { content: SRT, target: "srt" }], ["convert_subtitle", { content: SRT, target: "ebustl" }],
      ["convert_subtitle", { content: SRT, target: "srt", output: "s3://subs/out/a.srt" }], ["convert_subtitle", { content: SRT, target: "bad" }], ["convert_subtitle", { content: SRT }],
      ["preview_text", { jobId: id, which: "output", maxBytes: 1 }], ["preview_text", { jobId: id }], ["preview_text", { jobId: id, which: "output", cursor: "bad cursor" }],
      ["list_allowed_folders", {}],
    ];
    const seen = new Set<string>();
    for (const [name, args] of calls) {
      const tool = tools.find((t) => t.name === name)!; expect(tool?.outputSchema, name).toBeTruthy();
      const validate = ajv.compile(tool.outputSchema!);
      const r = await callTool(h, name, args);
      expect(r.structuredContent, name).toBeTruthy();
      const ok = validate(r.structuredContent);
      expect(ok, `${name} ${JSON.stringify(args)}: ${ajv.errorsText(validate.errors)}`).toBe(true);
      seen.add(name);
    }
    expect([...seen].sort()).toEqual(tools.map((t) => t.name).sort()); // every registered tool exercised
  });
  it("p6b item 2: a missing argument is stated once in the error text", async () => {
    h = await harness();
    for (const [name, args, field] of [["preview_text", { jobId: id }, "which"], ["get_profile", {}, "name"]] as const) {
      const text = (await callTool(h, name, args)).content[0].text as string;
      expect(occurrences(text, `\`${field}\` is required`), text).toBe(1);
    }
  });
});

describe("QA p7 finding 6 / p8 item 5: request ids, attempts and logging", () => {
  it("a retried file fetch gets <id>.f.r1 and attempts 2; the metadata request stays a single attempt", async () => {
    h = await harness(); const ids: string[] = []; let failed = false;
    mswServer.use(http.get(endpoint, ({ request }) => { ids.push(request.headers.get("x-request-id")!); return HttpResponse.json(job()); }),
      http.get(`${endpoint}/output`, ({ request }) => {
        ids.push(request.headers.get("x-request-id")!);
        if (!failed) { failed = true; return problem(503, "queue-full", {}, { "retry-after": "0" }); }
        return new HttpResponse(SRT);
      }));
    const r = await callTool(h, "preview_text", { jobId: id, which: "output" });
    expect(r.isError).toBeFalsy();
    expect(ids).toEqual([ids[0], `${ids[0]}.f`, `${ids[0]}.f.r1`]);
    const line = h.logs.map((l) => JSON.parse(l)).find((l: any) => l.tool === "preview_text");
    expect(line).toMatchObject({ attempts: 2, requestIds: ids });
  });
  it("a binary preview adds <id>.s for the SRT conversion, all ids distinct, attempts 1", async () => {
    h = await harness(); const ids: string[] = [];
    const rec = (r: Request) => ids.push(r.headers.get("x-request-id")!);
    mswServer.use(http.get(endpoint, ({ request }) => { rec(request); return HttpResponse.json(job({ result: { outputs: [{ kind: "binary", formatId: "ebustl" }] }, output: "s3://subs/out/a.stl" })); }),
      http.get(`${endpoint}/output`, ({ request }) => { rec(request); return new HttpResponse(Buffer.from("850STL\0")); }),
      http.post(`${API}/v1/convert/json`, ({ request }) => { rec(request); return HttpResponse.json(convertOk([{ fileName: "a.srt", content: SRT, formatId: "subrip" }])); }));
    expect((await callTool(h, "preview_text", { jobId: id, which: "output" })).isError).toBeFalsy();
    expect(ids).toEqual([ids[0], `${ids[0]}.f`, `${ids[0]}.s`]);
    expect(h.logs.map((l) => JSON.parse(l)).find((l: any) => l.tool === "preview_text").attempts).toBe(1);
  });
  it("presigned query strings never reach logs, results or text, even with SUBTITLE_MCP_LOG_PATHS=true", async () => {
    h = await harness({ logPaths: true });
    mswServer.use(http.post(`${API}/v1/convert/json`, () => HttpResponse.json({ id, ...convertOk([{ fileName: "a.vtt", content: "WEBVTT\n" }]) })),
      http.post(`${API}/v1/detect`, () => HttpResponse.json({ format: "SubRip", id: "subrip", encoding: "utf-8", encodingConfidence: "bom", paragraphs: 1 })));
    const input = "https://user:pw@mam.example.com/in/show.srt?X-Amz-Credential=FAKECRED&X-Amz-Signature=FAKESIG";
    const results = [await callTool(h, "convert_subtitle", { input, target: "vtt" }), await callTool(h, "detect_format", { input })];
    const lines = h.logs.map((l) => JSON.parse(l)).filter((l: any) => l.tool);
    expect(lines.map((l: any) => l.source)).toEqual(["https", "https"]);
    expect(lines[0].inputHash).toBe("https://mam.example.com/in/show.srt");
    const all = h.logs.join("\n") + JSON.stringify(results);
    for (const secret of ["FAKECRED", "FAKESIG", "user:pw"]) expect(all).not.toContain(secret);
  });
});
