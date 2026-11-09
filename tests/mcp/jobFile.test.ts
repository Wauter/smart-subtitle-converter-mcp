import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { API, SRT, baseHandlers, callTool, harness, mswServer, recorded, convertOk, problem, type Harness } from "../helpers/harness.js";
import { apiInfo } from "../../src/api/info.js";
let h: Harness | undefined;
const id = "ab0123456789abcdef0123456789abcdef";
const endpoint = `${API}/v1/jobs/${id}`;
const job = () => ({ id, status: "succeeded", input: "file:///data/in/show.srt", output: "s3://subs/out/show.vtt", result: { detected: { encoding: "utf-8" }, outputs: [{ encoding: "utf-8" }] } });
beforeAll(() => mswServer.listen({ onUnhandledFrame: "error" })); afterAll(() => mswServer.close());
beforeEach(() => { recorded.length = 0; apiInfo.probedAt = Date.now(); mswServer.use(...baseHandlers(), http.get(endpoint, () => HttpResponse.json(job()))); });
afterEach(async () => { await h?.close(); h = undefined; mswServer.resetHandlers(); });

describe("get_job_file", () => {
  it("reads input text into structuredContent.text (and a text block) with no detect/convert", async () => {
    h = await harness(); await h.client.listTools();
    mswServer.use(http.get(`${endpoint}/input`, () => new HttpResponse(SRT, { headers: { "content-type": "application/x-subrip" } })));
    const r = await callTool(h, "get_job_file", { jobId: id, which: "input" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ jobId: id, which: "input", fileName: "show.srt", mediaType: "application/x-subrip", bytes: Buffer.byteLength(SRT), location: "file:///data/in/show.srt",
      text: SRT, truncated: false, returnedBytes: Buffer.byteLength(SRT), totalBytes: Buffer.byteLength(SRT), returnedCues: 1, totalCues: 1, warnings: [] });
    expect(r.content[1]).toEqual({ type: "text", text: SRT }); expect(r.content[0].text).toContain("The content is in `text`");
    expect(recorded.every(x => x.method === "GET")).toBe(true);
    expect(h.logs.join("\n")).not.toContain("Hello");
  });
  it("encodes literal file-path query/hash delimiters instead of treating them as URI secrets", async () => {
    h = await harness(); mswServer.use(http.get(endpoint, () => HttpResponse.json({ ...job(), input: "/data/in/show?literal#name.srt" })), http.get(`${endpoint}/input`, () => new HttpResponse("Hello", { headers: { "content-type": "text/plain" } })));
    const r = await callTool(h, "get_job_file", { jobId: id, which: "input" });
    expect(r.structuredContent.location).toBe("file:///data/in/show%3Fliteral%23name.srt"); expect(r.structuredContent.fileName).toBe("show?literal#name.srt");
  });
  it("decodes a legacy-encoded text file as text, not base64", async () => {
    h = await harness(); const bytes = Buffer.from("1\n00:00:01,000 --> 00:00:02,000\ncaf\xe9\n", "latin1");
    mswServer.use(http.get(endpoint, () => HttpResponse.json({ ...job(), result: { detected: { kind: "text", encoding: "windows-1252", id: "subrip" } } })), http.get(`${endpoint}/input`, () => new HttpResponse(bytes)));
    const r = await callTool(h, "get_job_file", { jobId: id, which: "input" });
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
    const r = await callTool(h, "get_job_file", { jobId: id, which });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ fileName: "show.stl", bytes: STL.length, format: "ebustl", text: convertedSrt, truncated: false, totalCues: 2, returnedCues: 2, convertedFrom: "ebustl", convertedTo: "srt" });
    expect(r.structuredContent.warnings).toEqual([{ code: "styling-dropped", message: "Colours are not kept in SRT", hint: "Use a richer target" }]);
    const body = recorded.find(x => x.path === "/v1/convert/json")!.body;
    expect(body).toEqual({ content: STL.toString("base64"), contentEncoding: "base64", fileName: "show.stl", target: "srt", profile: { encoding: { output: "utf-8-no-bom" }, source: { format: "ebustl" } } });
    expect(body.output).toBeUndefined();
    expect(r.content.map((c: any) => c.type)).toEqual(["text", "text"]); expect(r.content[1].text).toBe(convertedSrt);
    expect(JSON.stringify(r)).not.toContain(STL.toString("base64")); expect(JSON.stringify(r)).not.toMatch(/resourceUri|"inline"|subtitleedit:/);
    expect(r.content[0].text).toMatch(/binary ebustl file, so its text is shown converted to SRT \(2 cues\); the stored file is unchanged.*styling-dropped/);
  });
  it("treats NUL-containing bytes of unknown kind as binary", async () => {
    h = await harness(); mswServer.use(http.get(endpoint, () => HttpResponse.json({ ...job(), result: {} })), http.get(`${endpoint}/output`, () => new HttpResponse(Buffer.from([0, 255, 128, 50]))), http.post(`${API}/v1/convert/json`, () => srtResponse()));
    const r = await callTool(h, "get_job_file", { jobId: id, which: "output" });
    expect(r.structuredContent).toMatchObject({ bytes: 4, convertedFrom: "ebustl", convertedTo: "srt", text: convertedSrt });
    expect(recorded.find(x => x.path === "/v1/convert/json")!.body.profile.source).toBeUndefined();
  });
  it("reuses the PAC code page the job wrote when reading its output", async () => {
    h = await harness();
    mswServer.use(http.get(endpoint, () => HttpResponse.json(binaryJob({ outputs: [{ kind: "binary", formatId: "pacscreenelectronics" }], profile: { formatOptions: { pac: { codePage: "greek" } } } }))),
      http.get(`${endpoint}/output`, () => new HttpResponse(STL)), http.post(`${API}/v1/convert/json`, () => srtResponse()));
    await callTool(h, "get_job_file", { jobId: id, which: "output" });
    expect(recorded.find(x => x.path === "/v1/convert/json")!.body.profile).toEqual({ encoding: { output: "utf-8-no-bom" }, source: { format: "pacscreenelectronics" }, formatOptions: { pac: { inputCodePage: "greek" } } });
  });
  it("returns a failed conversion as the structured error with object candidates and a convert_subtitle hint", async () => {
    h = await harness();
    const candidates = [{ encoding: "windows-1256", language: "ar", hits: 12, sample: "مرحبا" }, { encoding: "windows-1255", language: null, hits: 3, sample: "שלום" }];
    mswServer.use(http.get(endpoint, () => HttpResponse.json(binaryJob({ detected: { kind: "binary", id: "pacscreenelectronics" } }))), http.get(`${endpoint}/input`, () => new HttpResponse(STL)),
      http.post(`${API}/v1/convert/json`, () => problem(422, "ambiguous-encoding", { candidates, probe: "text-encoding" })));
    const r = await callTool(h, "get_job_file", { jobId: id, which: "input" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toMatchObject({ code: "ambiguous-encoding", candidates, probe: "text-encoding", jobId: id });
    expect(r.structuredContent.error.hint).toContain('call convert_subtitle with input "s3://subs/in/show.stl", target "srt"');
    expect(r.content[0].text).toContain('\nCandidates:\n  - windows-1256 (ar, 12 words): "مرحبا"\n  - windows-1255 (3 words): "שלום"');
    expect(r.content[0].text).not.toContain("[object Object]");
  });
  it("truncates long SRT at the last whole cue, never mid-character, and says so", async () => {
    h = await harness({ inlineTextMaxBytes: 179 }); // cue = 71 bytes; byte 179 falls inside a Devanagari character of cue 3
    const cue = (n: number) => `${n}\n00:00:0${n},000 --> 00:00:0${n},500\nनमस्ते दुनिया\n\n`; // Devanagari: 3 bytes per char
    const full = [1, 2, 3, 4, 5].map(cue).join("");
    mswServer.use(http.get(`${endpoint}/output`, () => new HttpResponse(full, { headers: { "content-type": "application/x-subrip" } })),
      http.get(endpoint, () => HttpResponse.json({ ...job(), output: "s3://subs/out/show.srt", result: { outputs: [{ encoding: "utf-8", formatId: "subrip" }] } })));
    const r = await callTool(h, "get_job_file", { jobId: id, which: "output" });
    const s = r.structuredContent;
    expect(s.truncated).toBe(true); expect(s.totalBytes).toBe(Buffer.byteLength(full)); expect(s.returnedBytes).toBe(142);
    expect(s.text).toBe(cue(1) + cue(2)); expect(s.returnedBytes).toBe(Buffer.byteLength(s.text)); expect(s).toMatchObject({ returnedCues: 2, totalCues: 5 });
    expect(r.content[1].text).toBe(s.text);
    expect(r.content[0].text).toContain(`TEXT TRUNCATED: returned the first ${s.returnedBytes} of ${s.totalBytes} bytes (cues 1–2 of 5)`);
  });
  it("truncates other text formats at the last full line", async () => {
    h = await harness({ inlineTextMaxBytes: 16 }); const body = '{\n "subtitle": "Hello"\n}\n';
    mswServer.use(http.get(`${endpoint}/output`, () => new HttpResponse(body, { headers: { "content-type": "application/json" } })));
    const r = await callTool(h, "get_job_file", { jobId: id, which: "output" });
    expect(r.structuredContent).toMatchObject({ text: "{\n", truncated: true, returnedBytes: 2, totalBytes: Buffer.byteLength(body), bytes: Buffer.byteLength(body) });
    expect(r.structuredContent.totalCues).toBeUndefined(); expect(r.content).toHaveLength(2);
  });
  it("says a missing jobId/which is required and lists the valid values", async () => {
    h = await harness();
    const missing = (await callTool(h, "get_job_file", { jobId: id })).structuredContent.error;
    expect(missing.code).toBe("invalid-arguments"); expect(missing.detail).toBe('Invalid arguments: /which: `which` is required (valid values: "input" | "output").');
    const bad = (await callTool(h, "get_job_file", { jobId: id, which: "both" })).structuredContent.error;
    expect(bad.detail).toBe('Invalid arguments: /which: `which` must be one of the valid values: "input" | "output"; got "both".');
    const none = (await callTool(h, "get_job_file", {})).structuredContent.error;
    expect(none.errors[0].message).toBe("`jobId` is required (Job id (`jobId`) returned by convert_subtitle).");
    const tools = (await h.client.listTools()).tools; const t = tools.find(x => x.name === "get_job_file")!;
    expect((t.inputSchema.properties!.which as any).description).toContain("input | output"); expect(t.inputSchema.required).toEqual(["jobId", "which"]);
    expect(t.description).toContain("returned as text in `text`"); expect(JSON.stringify(t.outputSchema)).not.toContain("resourceUri");
  });
  it.each(["job-not-ready", "job-not-found", "job-input-not-stored", "job-output-not-stored", "job-file-gone", "job-location-not-replayable"])("passes through %s with job id, hint, and redacted location", async (code) => {
    h = await harness(); await h.client.listTools(); let gets = 0;
    const status = ["job-not-found", "job-file-gone"].includes(code) ? 404 : 409;
    const problem = () => HttpResponse.json({ code, status, detail: "Job file unavailable", hint: "Inspect the original result; do not blindly resubmit.", ...(["job-file-gone", "job-location-not-replayable"].includes(code) ? { location: "https://user:secret@mam.example.com/show.srt?signature=hidden" } : {}) }, { status });
    mswServer.use(http.get(endpoint, () => code === "job-not-found" ? problem() : HttpResponse.json(job())), http.get(`${endpoint}/output`, () => { gets++; return problem(); }));
    const r = await callTool(h, "get_job_file", { jobId: id, which: "output" });
    expect(r.isError).toBe(true); expect(r.structuredContent.error).toMatchObject({ code, jobId: id }); expect(r.structuredContent.error.hint).toContain("original result");
    expect(gets).toBe(code === "job-not-found" ? 0 : 1);
    expect(JSON.stringify(r)).not.toMatch(/signature|hidden|user:secret/);
    if (["job-file-gone", "job-location-not-replayable"].includes(code)) expect(r.structuredContent.error.location).toBe("https://mam.example.com/show.srt");
  });
  it("only accepts jobId and input/output; no URI, sidecar/both or save path", async () => {
    h = await harness();
    for (const args of [{ jobId: "../etc", which: "input" }, { jobId: id, which: "sidecar" }, { jobId: id, which: "both" }, { jobId: id, which: "output", outputPath: "/tmp/file" }, { jobId: id, which: "input", saveTo: "/tmp/file" }, { jobId: id, which: "input", input: "https://example.com" }]) {
      expect((await callTool(h, "get_job_file", args)).structuredContent.error.code).toBe("invalid-arguments");
    }
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
    h = await harness({ timeoutMs }); mswServer.use(http.get(`${API}/v1/limits`, () => HttpResponse.json({ requestMaxWaitSeconds: maxWait, storage: { inputSchemes: ["file", "s3", "https"], outputSchemes: ["file", "s3", "https"] } })));
    await callTool(h, "convert_subtitle", { content: SRT, target: "vtt" });
    expect(recorded.find(x => x.path === "/v1/convert/json")?.headers.prefer).toBe(`wait=${expected}`);
    const tools = (await h.client.listTools()).tools; expect(tools.find(t => t.name === "convert_subtitle")!.description).toContain("API storage enabled: file, s3, https");
  });
});
