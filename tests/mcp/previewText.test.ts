import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { API, EXTENSIONS, SRT, baseHandlers, callTool, harness, mswServer, recorded, convertOk, problem, type Harness } from "../helpers/harness.js";
import { apiInfo } from "../../src/api/info.js";
let h: Harness | undefined;
const id = "ab0123456789abcdef0123456789abcdef";
const endpoint = `${API}/v1/jobs/${id}`;
const job = () => ({ id, status: "succeeded", input: "file:///data/in/show.srt", output: "s3://subs/out/show.vtt", result: { detected: { encoding: "utf-8" }, outputs: [{ encoding: "utf-8" }] } });
beforeAll(() => mswServer.listen({ onUnhandledFrame: "error" })); afterAll(() => mswServer.close());
beforeEach(() => { recorded.length = 0; apiInfo.probedAt = Date.now(); mswServer.use(...baseHandlers(), http.get(endpoint, () => HttpResponse.json(job()))); });
afterEach(async () => { await h?.close(); h = undefined; mswServer.resetHandlers(); });

describe("preview_text", () => {
  it("reads input text into structuredContent.text once (no repeated text block), with no detect/convert", async () => {
    h = await harness(); await h.client.listTools();
    mswServer.use(http.get(`${endpoint}/input`, () => new HttpResponse(SRT, { headers: { "content-type": "application/x-subrip" } })));
    const r = await callTool(h, "preview_text", { jobId: id, which: "input" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ source: "job", jobId: id, which: "input", fileName: "show.srt", mediaType: "application/x-subrip", bytes: Buffer.byteLength(SRT), location: "file:///data/in/show.srt",
      text: SRT, unit: "cue", maxBytes: 65536, truncated: false, returnedBytes: Buffer.byteLength(SRT), totalBytes: Buffer.byteLength(SRT), fromCue: 1, toCue: 1, returnedCues: 1, totalCues: 1, warnings: [] });
    expect(r.content).toHaveLength(1); expect(r.content[0].text).not.toContain("Hello");
    expect(r.content[0].text).toContain("Showing all 1 cue"); expect(r.content[0].text).toContain("`text` field (sent once");
    expect(recorded.every(x => x.method === "GET")).toBe(true);
    expect(h.logs.join("\n")).not.toContain("Hello");
  });
  it("encodes literal file-path query/hash delimiters instead of treating them as URI secrets", async () => {
    h = await harness(); mswServer.use(http.get(endpoint, () => HttpResponse.json({ ...job(), input: "/data/in/show?literal#name.srt" })), http.get(`${endpoint}/input`, () => new HttpResponse("Hello", { headers: { "content-type": "text/plain" } })));
    const r = await callTool(h, "preview_text", { jobId: id, which: "input" });
    expect(r.structuredContent.location).toBe("file:///data/in/show%3Fliteral%23name.srt"); expect(r.structuredContent.fileName).toBe("show?literal#name.srt");
  });
  it("decodes a legacy-encoded text file as text, not base64", async () => {
    h = await harness(); const bytes = Buffer.from("1\n00:00:01,000 --> 00:00:02,000\ncaf\xe9\n", "latin1");
    mswServer.use(http.get(endpoint, () => HttpResponse.json({ ...job(), result: { detected: { kind: "text", encoding: "windows-1252", id: "subrip" } } })), http.get(`${endpoint}/input`, () => new HttpResponse(bytes)));
    const r = await callTool(h, "preview_text", { jobId: id, which: "input" });
    expect(r.structuredContent).toMatchObject({ text: "1\n00:00:01,000 --> 00:00:02,000\ncafé\n", format: "subrip", truncated: false });
    expect(r.structuredContent.convertedFrom).toBeUndefined(); expect(recorded.some(x => x.method === "POST")).toBe(false);
  });

  const STL = Buffer.from("850STL25.01\0binary header and data\n");
  const convertedSrt = "1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n";
  const binaryJob = (extra: any = {}) => ({ ...job(), input: "s3://subs/in/show.stl", output: "s3://subs/out/show.stl", result: { detected: { kind: "binary", encoding: "utf-8", id: "ebustl" }, outputs: [{ kind: "binary", encoding: "utf-8", formatId: "ebustl" }], ...extra } });
  const srtResponse = (warnings: unknown[] = []) => HttpResponse.json(convertOk([{ fileName: "show.srt", content: "\uFEFF" + convertedSrt, formatId: "subrip" }], { detected: { format: "EBU STL", id: "ebustl", encoding: "iso-6937", encodingConfidence: "header", paragraphs: 2, kind: "binary" }, warnings }));

  it.each(["input", "output"] as const)("converts a binary %s to SRT text via the API, inline only, never base64", async (which) => {
    h = await harness();
    mswServer.use(http.get(endpoint, () => HttpResponse.json(binaryJob())), http.get(`${endpoint}/${which}`, () => new HttpResponse(STL, { headers: { "content-type": "application/octet-stream" } })),
      http.post(`${API}/v1/convert/json`, () => srtResponse([{ code: "styling-dropped", message: "Colours are not kept in SRT", hint: "Use a richer target" }])));
    const r = await callTool(h, "preview_text", { jobId: id, which });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ fileName: "show.stl", bytes: STL.length, format: "ebustl", text: convertedSrt, truncated: false, unit: "cue", totalCues: 2, returnedCues: 2, convertedFrom: "ebustl", convertedTo: "srt" });
    expect(r.structuredContent.warnings).toEqual([{ code: "styling-dropped", message: "Colours are not kept in SRT", hint: "Use a richer target" }]);
    const body = recorded.find(x => x.path === "/v1/convert/json")!.body;
    expect(body).toEqual({ content: STL.toString("base64"), contentEncoding: "base64", fileName: "show.stl", target: "srt", profile: { encoding: { output: "utf-8-no-bom" }, source: { format: "ebustl" } } });
    expect(body.output).toBeUndefined();
    expect(r.content).toHaveLength(1); expect(r.content[0].text).not.toContain("World");
    expect(JSON.stringify(r)).not.toContain(STL.toString("base64")); expect(JSON.stringify(r)).not.toMatch(/resourceUri|"inline"|subtitleedit:/);
    expect(r.content[0].text).toMatch(/binary ebustl file, so its text is shown converted to SRT; the stored file is unchanged\. Showing all 2 cues.*styling-dropped/);
  });
  const PAC = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0x80, 0x81]);
  const pacJob = (profile: any) => ({ ...job(), input: "s3://subs/in/show.pac", output: "s3://subs/out/show.pac", result: { profile, detected: { kind: "binary", encoding: "utf-8", id: "pac" }, outputs: [{ kind: "binary", encoding: "utf-8", formatId: "pac" }] } });
  it("a rate-less binary job file (PAC) is shown at the rate the job used: output target.fps, else source.fps; input source.fps", async () => {
    for (const [profile, which, fps] of [[{ source: { fps: 25 }, target: { fps: 29.97 } }, "output", 29.97], [{ source: { fps: 25 } }, "output", 25], [{ source: { fps: 25 }, target: { fps: 30 } }, "input", 25]] as const) {
      recorded.length = 0; h = await harness();
      mswServer.use(http.get(endpoint, () => HttpResponse.json(pacJob(profile))), http.get(`${endpoint}/${which}`, () => new HttpResponse(PAC)), http.post(`${API}/v1/convert/json`, () => srtResponse()));
      const r = await callTool(h, "preview_text", { jobId: id, which });
      expect(r.isError, JSON.stringify(r.structuredContent?.error)).toBeFalsy();
      expect(recorded.find(x => x.path === "/v1/convert/json")!.body.profile.source).toEqual({ format: "pac", fps });
      await h.close(); h = undefined;
    }
  });
  it("frame-rate-required for a rate-less binary file asks for `fps`, and `fps` is sent as source.fps", async () => {
    h = await harness();
    mswServer.use(http.get(endpoint, () => HttpResponse.json(pacJob({}))), http.get(`${endpoint}/output`, () => new HttpResponse(PAC)),
      http.post(`${API}/v1/convert/json`, async ({ request }) => ((await request.clone().json()) as any).profile.source.fps ? srtResponse() : problem(422, "frame-rate-required", { errors: [{ pointer: "/source/fps", message: "Required" }] })));
    const bad = await callTool(h, "preview_text", { jobId: id, which: "output" });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.error).toMatchObject({ code: "frame-rate-required", errors: [{ pointer: "/fps" }] });
    expect(bad.structuredContent.error.hint).toContain("Call preview_text again with `fps`");
    const ok = await callTool(h, "preview_text", { jobId: id, which: "output", fps: 25 });
    expect(ok.isError, JSON.stringify(ok.structuredContent?.error)).toBeFalsy();
    expect(recorded.filter(x => x.path === "/v1/convert/json").at(-1)!.body.profile.source).toEqual({ format: "pac", fps: 25 });
  });
  it("treats NUL-containing bytes of unknown kind as binary", async () => {
    h = await harness(); mswServer.use(http.get(endpoint, () => HttpResponse.json({ ...job(), result: {} })), http.get(`${endpoint}/output`, () => new HttpResponse(Buffer.from([0, 255, 128, 50]))), http.post(`${API}/v1/convert/json`, () => srtResponse()));
    const r = await callTool(h, "preview_text", { jobId: id, which: "output" });
    expect(r.structuredContent).toMatchObject({ bytes: 4, convertedFrom: "ebustl", convertedTo: "srt", text: convertedSrt });
    expect(recorded.find(x => x.path === "/v1/convert/json")!.body.profile.source).toBeUndefined();
  });
  it("reuses the PAC code page the job wrote when reading its output", async () => {
    h = await harness();
    mswServer.use(http.get(endpoint, () => HttpResponse.json(binaryJob({ outputs: [{ kind: "binary", formatId: "pacscreenelectronics" }], profile: { formatOptions: { pac: { codePage: "greek" } } } }))),
      http.get(`${endpoint}/output`, () => new HttpResponse(STL)), http.post(`${API}/v1/convert/json`, () => srtResponse()));
    await callTool(h, "preview_text", { jobId: id, which: "output" });
    expect(recorded.find(x => x.path === "/v1/convert/json")!.body.profile).toEqual({ encoding: { output: "utf-8-no-bom" }, source: { format: "pacscreenelectronics" }, formatOptions: { pac: { inputCodePage: "greek" } } });
  });
  it("returns a failed conversion as the structured error with object candidates and a convert_subtitle hint", async () => {
    h = await harness();
    const candidates = [{ encoding: "windows-1256", language: "ar", hits: 12, sample: "مرحبا" }, { encoding: "windows-1255", language: null, hits: 3, sample: "שלום" }];
    mswServer.use(http.get(endpoint, () => HttpResponse.json(binaryJob({ detected: { kind: "binary", id: "pacscreenelectronics" } }))), http.get(`${endpoint}/input`, () => new HttpResponse(STL)),
      http.post(`${API}/v1/convert/json`, () => problem(422, "ambiguous-encoding", { candidates, probe: "text-encoding" })));
    const r = await callTool(h, "preview_text", { jobId: id, which: "input" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toMatchObject({ code: "ambiguous-encoding", candidates, probe: "text-encoding", jobId: id });
    expect(r.structuredContent.error.hint).toContain('call convert_subtitle with input "s3://subs/in/show.stl", target "srt"');
    expect(r.content[0].text).toContain('\nCandidates:\n  - windows-1256 (ar, 12 words): "مرحبا"\n  - windows-1255 (3 words): "שלום"');
    expect(r.content[0].text).not.toContain("[object Object]");
  });
  const cueOf = (n: number, text: string) => `${n}\n00:00:${String(n % 60).padStart(2, "0")},000 --> 00:00:${String(n % 60).padStart(2, "0")},500\n${text}\n\n`;
  const longSrt = (n: number, text = "नमस्ते दुनिया ".repeat(40)) => Array.from({ length: n }, (_, i) => cueOf(i + 1, text)).join("");
  const serveOutput = (body: () => string | Buffer) => mswServer.use(
    http.get(`${endpoint}/output`, () => new HttpResponse(body(), { headers: { "content-type": "application/x-subrip" } })),
    http.get(endpoint, () => HttpResponse.json({ ...job(), output: "s3://subs/out/show.srt", result: { outputs: [{ encoding: "utf-8", formatId: "subrip" }] } })));

  it("pages long SRT on whole cues with a next cursor until the last page; pages join to the full text", async () => {
    h = await harness(); const full = longSrt(40); serveOutput(() => "\uFEFF" + full);
    const pages: any[] = []; let cursor: string | undefined;
    do {
      const r = await callTool(h, "preview_text", { jobId: id, which: "output", maxBytes: 8192, ...(cursor ? { cursor } : {}) });
      expect(r.isError).toBeFalsy(); pages.push(r.structuredContent); cursor = r.structuredContent.next;
      expect(r.structuredContent.returnedBytes).toBeLessThanOrEqual(8192);
      expect(r.content).toHaveLength(1);
    } while (cursor);
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.map((p) => p.text).join("")).toBe(full);
    expect(pages[0]).toMatchObject({ truncated: true, fromCue: 1, totalCues: 40, totalBytes: Buffer.byteLength(full), maxBytes: 8192 });
    for (let i = 1; i < pages.length; i++) expect(pages[i].fromCue).toBe(pages[i - 1].toCue + 1);
    expect(pages.at(-1)).toMatchObject({ truncated: false, toCue: 40 }); expect(pages.at(-1).next).toBeUndefined();
  });
  it("later pages keep the first page's maxBytes unless the call sets it again (README examples: page 2 came back at the default size)", async () => {
    h = await harness(); const full = longSrt(40); serveOutput(() => full);
    const first = (await callTool(h, "preview_text", { jobId: id, which: "output", maxBytes: 4096 })).structuredContent;
    const second = (await callTool(h, "preview_text", { jobId: id, which: "output", cursor: first.next })).structuredContent;
    expect(second.maxBytes).toBe(4096); expect(second.returnedBytes).toBeLessThanOrEqual(4096); expect(second.fromCue).toBe(first.toCue + 1);
    const third = (await callTool(h, "preview_text", { jobId: id, which: "output", cursor: second.next, maxBytes: 8192 })).structuredContent;
    expect(third.maxBytes).toBe(8192); expect(third.returnedBytes).toBeGreaterThan(4096);
  });
  it("clamps maxBytes to the server range and uses the configured default", async () => {
    h = await harness({ previewDefaultBytes: 5000, previewMaxBytes: 9000 }); serveOutput(() => longSrt(40));
    const def = (await callTool(h, "preview_text", { jobId: id, which: "output" })).structuredContent;
    expect(def.maxBytes).toBe(5000); expect(def.warnings).toEqual([]);
    expect((await callTool(h, "preview_text", { jobId: id, which: "output", maxBytes: 6000 })).structuredContent.warnings).toEqual([]);
    const small = await callTool(h, "preview_text", { jobId: id, which: "output", maxBytes: 1 });
    expect(small.structuredContent.maxBytes).toBe(4096);
    expect(small.structuredContent.warnings).toEqual([expect.objectContaining({ code: "max-bytes-clamped", details: { fields: { requested: "1", applied: "4096" } } })]);
    expect(small.content[0].text).toContain("Warning max-bytes-clamped: maxBytes 1 is outside the allowed range 4096..9000; pages use 4096 bytes.");
    const bigR = await callTool(h, "preview_text", { jobId: id, which: "output", maxBytes: 10_000_000 }); const big = bigR.structuredContent;
    expect(big.maxBytes).toBe(9000); expect(big.returnedBytes).toBeLessThanOrEqual(9000);
    expect(big.warnings[0]).toMatchObject({ code: "max-bytes-clamped", details: { fields: { requested: "10000000", applied: "9000" } } }); expect(big.warnings[0].hint).toContain("SUBTITLE_MCP_PREVIEW_MAX_BYTES");
    for (const maxBytes of [0, -5, 1.5, "4096"]) expect((await callTool(h, "preview_text", { jobId: id, which: "output", maxBytes })).structuredContent.error.code).toBe("invalid-arguments");
  });
  it("returns a cue larger than maxBytes alone, and refuses one larger than the server maximum", async () => {
    h = await harness({ previewMaxBytes: 8192 });
    let body = cueOf(1, "a") + cueOf(2, "b".repeat(6000)) + cueOf(3, "c"); serveOutput(() => body);
    const first = (await callTool(h, "preview_text", { jobId: id, which: "output", maxBytes: 4096 })).structuredContent;
    expect(first).toMatchObject({ fromCue: 1, toCue: 1, truncated: true });
    const second = (await callTool(h, "preview_text", { jobId: id, which: "output", maxBytes: 4096, cursor: first.next })).structuredContent;
    expect(second).toMatchObject({ fromCue: 2, toCue: 2, returnedCues: 1, text: cueOf(2, "b".repeat(6000)) }); expect(second.returnedBytes).toBeGreaterThan(4096);
    body = cueOf(1, "x".repeat(9000));
    const e = (await callTool(h, "preview_text", { jobId: id, which: "output" })).structuredContent.error;
    expect(e).toMatchObject({ code: "preview-cue-too-large", limit: { name: "SUBTITLE_MCP_PREVIEW_MAX_BYTES", value: 8192 }, location: "s3://subs/out/show.srt" });
    expect(e.detail).toContain("more than SUBTITLE_MCP_PREVIEW_MAX_BYTES (8192)");
    expect(e.hint).toContain("raise SUBTITLE_MCP_PREVIEW_MAX_BYTES (up to 1048576)"); expect(e.hint).toContain("read the stored file directly at s3://subs/out/show.srt");
    expect(e.hint).not.toMatch(/convert/i);
  });
  it("fails with preview-source-changed when the file changes between pages, and rejects foreign cursors", async () => {
    h = await harness(); let body = longSrt(40); serveOutput(() => body);
    const first = (await callTool(h, "preview_text", { jobId: id, which: "output", maxBytes: 8192 })).structuredContent;
    body = longSrt(40, "changed ".repeat(40));
    const r = await callTool(h, "preview_text", { jobId: id, which: "output", cursor: first.next });
    expect(r.structuredContent.error).toMatchObject({ code: "preview-source-changed", jobId: id }); expect(r.structuredContent.error.hint).toContain("without `cursor`");
    const before = recorded.length;
    expect((await callTool(h, "preview_text", { jobId: id, which: "output", cursor: "bm9wZQ" })).structuredContent.error.code).toBe("preview-cursor-invalid");
    expect(recorded.length).toBe(before); // a malformed cursor fails before any API call
    mswServer.use(http.get(`${endpoint}/input`, () => new HttpResponse(longSrt(40))));
    expect((await callTool(h, "preview_text", { jobId: id, which: "input", cursor: first.next })).structuredContent.error.code).toBe("preview-cursor-invalid");
  });
  it("counts attempts per request, not per call, and gives each request its own id (no duplicate requestId)", async () => {
    h = await harness(); const ids: string[] = [];
    mswServer.use(http.get(endpoint, ({ request }) => { ids.push(request.headers.get("x-request-id")!); return HttpResponse.json(job()); }),
      http.get(`${endpoint}/input`, ({ request }) => { ids.push(request.headers.get("x-request-id")!); return new HttpResponse(SRT); }));
    const r = await callTool(h, "preview_text", { jobId: id, which: "input" });
    expect(r.isError).toBeFalsy(); expect(ids).toHaveLength(2); expect(new Set(ids).size).toBe(2); expect(ids[1]).toBe(`${ids[0]}.f`);
    const line = h.logs.map((l) => JSON.parse(l)).find((l: any) => l.tool === "preview_text");
    expect(line.attempts).toBe(1); expect(line.requestIds).toEqual(ids);
  });
  it("pages other text formats on whole lines", async () => {
    h = await harness(); const body = Array.from({ length: 400 }, (_, i) => `{"line": ${i}, "text": "${"x".repeat(20)}"}\n`).join("");
    mswServer.use(http.get(`${endpoint}/output`, () => new HttpResponse(body, { headers: { "content-type": "application/json" } })));
    const r = (await callTool(h, "preview_text", { jobId: id, which: "output", maxBytes: 4096 })).structuredContent;
    expect(r).toMatchObject({ unit: "line", fromLine: 1, totalLines: 400, truncated: true }); expect(r.text.endsWith("\n")).toBe(true);
    expect(r.totalCues).toBeUndefined(); expect(body.startsWith(r.text)).toBe(true);
  });
  it("says a missing jobId/which is required and lists the valid values", async () => {
    h = await harness({ listEnabled: false });
    const missing = (await callTool(h, "preview_text", { jobId: id })).structuredContent.error;
    expect(missing.code).toBe("invalid-arguments"); expect(missing.detail).toBe('Invalid arguments: /which: `which` is required (valid values: "input" | "output").');
    const text = (await callTool(h, "preview_text", { jobId: id })).content[0].text;
    expect(text.split("`which` is required")).toHaveLength(2); // said once, not repeated as a field line
    const bad = (await callTool(h, "preview_text", { jobId: id, which: "both" })).structuredContent.error;
    expect(bad.detail).toBe('Invalid arguments: /which: `which` must be one of the valid values: "input" | "output"; got "both".');
    const none = (await callTool(h, "preview_text", {})).structuredContent.error;
    expect(none.errors[0].message).toBe("`jobId` is required (Job id (`jobId`) returned by convert_subtitle).");
    const tools = (await h.client.listTools()).tools; const t = tools.find(x => x.name === "preview_text")!;
    expect((t.inputSchema.properties!.which as any).description).toContain("input | output"); expect(t.inputSchema.required).toEqual(["jobId", "which"]);
    expect(t.description).toContain("not the file"); expect(JSON.stringify(t.outputSchema)).not.toContain("resourceUri");
    expect(Object.keys(t.inputSchema.properties!)).toEqual(["jobId", "which", "maxBytes", "fps", "cursor"]);
    expect(tools.some(x => x.name === "get_job_file")).toBe(false);
    const props = (t.outputSchema as any).properties;
    for (const [k, v] of Object.entries<any>(props)) if (!["error"].includes(k)) expect(v.description ?? v.anyOf?.[0]?.description, k).toBeTruthy();
    expect(props.warnings.anyOf).toBeUndefined(); expect(props.warnings.type).toBe("array");
  });
  it.each(["job-not-ready", "job-not-found", "job-input-not-stored", "job-output-not-stored", "job-file-gone", "job-location-not-replayable"])("passes through %s with job id, hint, and redacted location", async (code) => {
    h = await harness(); await h.client.listTools(); let gets = 0;
    const status = ["job-not-found", "job-file-gone"].includes(code) ? 404 : 409;
    const problem = () => HttpResponse.json({ code, status, detail: "Job file unavailable", hint: "Inspect the original result; do not blindly resubmit.", ...(["job-file-gone", "job-location-not-replayable"].includes(code) ? { location: "https://user:secret@mam.example.com/show.srt?signature=hidden" } : {}) }, { status });
    mswServer.use(http.get(endpoint, () => code === "job-not-found" ? problem() : HttpResponse.json(job())), http.get(`${endpoint}/output`, () => { gets++; return problem(); }));
    const r = await callTool(h, "preview_text", { jobId: id, which: "output" });
    expect(r.isError).toBe(true); expect(r.structuredContent.error).toMatchObject({ code, jobId: id });
    if (code === "job-output-not-stored") {
      expect(r.structuredContent.error.title).toBe("Job output not stored");
      expect(r.structuredContent.error.detail).toContain("attached as an embedded resource"); expect(r.structuredContent.error.hint).toContain("save it to disk");
    } else if (code === "job-input-not-stored") expect(r.structuredContent.error.detail).toContain("sent inline");
    else expect(r.structuredContent.error.hint).toContain("original result");
    expect(gets).toBe(code === "job-not-found" ? 0 : 1);
    expect(JSON.stringify(r)).not.toMatch(/signature|hidden|user:secret/);
    if (["job-file-gone", "job-location-not-replayable"].includes(code)) expect(r.structuredContent.error.location).toBe("https://mam.example.com/show.srt");
  });
  it("only accepts jobId, input/output, maxBytes and cursor; no URI, sidecar/both or save path", async () => {
    h = await harness();
    for (const args of [{ jobId: "../etc", which: "input" }, { jobId: id, which: "sidecar" }, { jobId: id, which: "both" }, { jobId: id, which: "output", outputPath: "/tmp/file" }, { jobId: id, which: "input", saveTo: "/tmp/file" }, { jobId: id, which: "input", input: "https://example.com" }, { jobId: id, which: "input", location: "s3://subs/in/a.srt" }]) {
      expect((await callTool(h, "preview_text", args)).structuredContent.error.code).toBe("invalid-arguments");
    }
    expect(recorded).toHaveLength(0);
    for (const cursor of ["", "has spaces!", "x".repeat(600)]) expect((await callTool(h, "preview_text", { jobId: id, which: "input", cursor })).structuredContent.error.code).toBe("preview-cursor-invalid");
    expect(recorded).toHaveLength(0);
  });
  it("passes replace to API destinations without a separate gate and rejects obsolete policies", async () => {
    h = await harness(); mswServer.use(http.post(`${API}/v1/convert/json`, () => HttpResponse.json(convertOk([{ fileName: "show.vtt", content: "WEBVTT" }]))));
    const r = await callTool(h, "convert_subtitle", { content: SRT, target: "vtt", output: "s3://subs/out/show.vtt", ifExists: "replace" }); expect(r.isError).toBeFalsy();
    expect(recorded.find(x => x.path === "/v1/convert/json")?.body.ifExists).toBe("replace");
    for (const policy of ["archive", "delete"]) expect((await callTool(h, "convert_subtitle", { content: SRT, target: "vtt", ifExists: policy })).structuredContent.error.code).toBe("invalid-arguments");
    const tools = (await h.client.listTools()).tools; expect((tools.find(t => t.name === "convert_subtitle")!.inputSchema.properties!.ifExists as any).enum).toEqual(["error", "replace"]);
  });
  it.each([[5000, 2, 2], [1000, 60, 1], [120000, undefined, 60]])("negotiates wait using timeout %s and API max %s", async (timeoutMs, maxWait, expected) => {
    h = await harness({ timeoutMs }); mswServer.use(http.get(`${API}/v1/limits`, () => HttpResponse.json({ requestMaxWaitSeconds: maxWait, storage: { extensions: EXTENSIONS, inputSchemes: ["file", "s3", "https"], outputSchemes: ["file", "s3", "https"] } })));
    await callTool(h, "convert_subtitle", { content: SRT, target: "vtt" });
    expect(recorded.find(x => x.path === "/v1/convert/json")?.headers.prefer).toBe(`wait=${expected}`);
    const tools = (await h.client.listTools()).tools; expect(tools.find(t => t.name === "convert_subtitle")!.description).toContain("API storage enabled: file, s3, https");
  });
});
