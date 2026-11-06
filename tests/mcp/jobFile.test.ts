import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { API, SRT, baseHandlers, callTool, harness, mswServer, recorded, convertOk, type Harness } from "../helpers/harness.js";
import { apiInfo } from "../../src/api/info.js";
let h: Harness | undefined;
const id = "ab0123456789abcdef0123456789abcdef";
const endpoint = `${API}/v1/jobs/${id}`;
const job = () => ({ id, status: "succeeded", input: "file:///data/in/show.srt", output: "s3://subs/out/show.vtt", result: { detected: { encoding: "utf-8" }, outputs: [{ encoding: "utf-8" }] } });
beforeAll(() => mswServer.listen({ onUnhandledFrame: "error" })); afterAll(() => mswServer.close());
beforeEach(() => { recorded.length = 0; apiInfo.probedAt = Date.now(); mswServer.use(...baseHandlers(), http.get(endpoint, () => HttpResponse.json(job()))); });
afterEach(async () => { await h?.close(); h = undefined; mswServer.resetHandlers(); });

describe("get_job_file", () => {
  it("reads input as inline Unicode with redacted metadata and no detect/convert", async () => {
    h = await harness(); await h.client.listTools();
    mswServer.use(http.get(`${endpoint}/input`, () => new HttpResponse(SRT, { headers: { "content-type": "application/x-subrip" } })));
    const r = await callTool(h, "get_job_file", { jobId: id, which: "input" });
    expect(r.isError).toBeFalsy(); expect(r.structuredContent).toMatchObject({ jobId: id, which: "input", fileName: "show.srt", location: "file:///data/in/show.srt", bytes: Buffer.byteLength(SRT), inline: "text", contentEncoding: "text" });
    expect(r.content[1].text).toBe(SRT); expect(recorded.every(x => x.method === "GET")).toBe(true);
    expect(h.logs.join("\n")).not.toContain("Hello");
  });
  it("encodes literal file-path query/hash delimiters instead of treating them as URI secrets", async () => {
    h = await harness(); mswServer.use(http.get(endpoint, () => HttpResponse.json({ ...job(), input: "/data/in/show?literal#name.srt" })), http.get(`${endpoint}/input`, () => new HttpResponse("Hello", { headers: { "content-type": "text/plain" } })));
    const r = await callTool(h, "get_job_file", { jobId: id, which: "input" });
    expect(r.structuredContent.location).toBe("file:///data/in/show%3Fliteral%23name.srt"); expect(r.structuredContent.fileName).toBe("show?literal#name.srt");
  });
  it.each(["input", "output"] as const)("keeps UTF-8-looking binary %s byte-exact", async (which) => {
    h = await harness(); const bytes = Buffer.from("ASCII binary header\0and data\n");
    mswServer.use(http.get(endpoint, () => HttpResponse.json({ ...job(), result: { detected: { kind: "binary", encoding: "utf-8" }, outputs: [{ kind: "binary", encoding: "utf-8" }] } })), http.get(`${endpoint}/${which}`, () => new HttpResponse(bytes, { headers: { "content-type": "application/octet-stream" } })));
    const r = await callTool(h, "get_job_file", { jobId: id, which });
    expect(r.structuredContent.contentEncoding).toBe("base64"); expect(r.structuredContent.inline).toBe("resource");
    expect(Buffer.from(r.content[1].resource.blob, "base64")).toEqual(bytes);
  });
  it("returns any binary as a byte-exact embedded resource", async () => {
    h = await harness(); const bytes = Buffer.from([0, 255, 128, 50]);
    mswServer.use(http.get(endpoint, () => HttpResponse.json({ ...job(), result: { outputs: [{ encoding: "binary" }] } })), http.get(`${endpoint}/output`, () => new HttpResponse(bytes, { headers: { "content-type": "application/octet-stream" } })));
    const r = await callTool(h, "get_job_file", { jobId: id, which: "output" });
    expect(r.structuredContent).toMatchObject({ bytes: 4, contentEncoding: "base64", inline: "resource", location: "s3://subs/out/show.vtt" });
    expect(Buffer.from(r.content[1].resource.blob, "base64")).toEqual(bytes); expect(r.structuredContent.resourceUri).toMatch(/^subtitleedit:\/\/outputs\//);
  });
  it("embeds large Unicode text and keeps JSON-media file bytes intact", async () => {
    h = await harness({ inlineTextMaxBytes: 8 }); const body = '{ "subtitle": "Hello" }\n';
    mswServer.use(http.get(`${endpoint}/output`, () => new HttpResponse(body, { headers: { "content-type": "application/json" } })));
    const r = await callTool(h, "get_job_file", { jobId: id, which: "output" });
    expect(r.structuredContent.inline).toBe("resource"); expect(r.content[1].resource.text).toBe(body);
    expect(r.structuredContent.bytes).toBe(Buffer.byteLength(body));
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
