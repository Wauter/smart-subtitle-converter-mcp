import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { http, HttpResponse } from "msw";
import { API, baseHandlers, callTool, convertOk, harness, mswServer, recorded, SRT, tmpDir, type Harness } from "../helpers/harness.js";
import { realpathRoots } from "../../src/fs/guard.js";
import { apiInfo } from "../../src/api/info.js";

beforeAll(() => mswServer.listen({ onUnhandledFrame: "error" }));
afterAll(() => mswServer.close());
let h: Harness | undefined;
beforeEach(() => {
  recorded.length = 0; apiInfo.probedAt = Date.now(); apiInfo.versionMismatch = false;
  mswServer.use(...baseHandlers());
});
afterEach(async () => { await h?.close(); h = undefined; mswServer.resetHandlers(); });
const id = "test_job";
const location = `/v1/jobs/${id}`;
const accepted = (loc = location) => HttpResponse.json({ id, status: "running" }, { status: 202, headers: { Location: loc, "Retry-After": "0" } });
const metadata = (output?: string): any => {
  const result: any = convertOk([{ fileName: "show.vtt", content: "WEBVTT\n" }], { id });
  delete result.outputs[0].content; result.outputs[0].bytes = 7;
  if (output) result.outputs[0].output = output;
  return result;
};

describe("API locations and jobs", () => {
  it("passes input/output/sidecar, polls 202 and reports stored metadata with jobId", async () => {
    h = await harness(); let polls = 0;
    mswServer.use(http.post(`${API}/v1/convert/json`, () => accepted()), http.get(`${API}${location}`, () => HttpResponse.json(
      ++polls === 1 ? { id, status: "running" } : { id, status: "succeeded", result: metadata("s3://subs/out/show.vtt") }, { headers: { "Retry-After": "0" } })));
    const r = await callTool(h, "convert_subtitle", { input: "https://mam.example.com/show.srt", output: "s3://subs/out/show.vtt", sidecar: true, target: "vtt" });
    expect(r.isError).toBeFalsy(); expect(r.structuredContent.jobId).toBe(id);
    expect(r.structuredContent.outputs[0]).toMatchObject({ output: "s3://subs/out/show.vtt", bytes: 7 });
    expect(r.structuredContent.outputs[0].inline).toBeUndefined(); expect(r.content).toHaveLength(1);
    expect(recorded.find((x) => x.path === "/v1/convert/json")!.body).toEqual({ input: "https://mam.example.com/show.srt", output: "s3://subs/out/show.vtt", sidecar: true, target: "vtt" });
    expect(polls).toBe(2);
  });
  it("surfaces a synchronous job id without changing inline bytes", async () => {
    h = await harness(); mswServer.use(http.post(`${API}/v1/convert/json`, () => HttpResponse.json(convertOk([{ fileName: "a.vtt", content: "WEBVTT\n" }], { id }))));
    const r = await callTool(h, "convert_subtitle", { content: SRT, target: "vtt" });
    expect(r.structuredContent.jobId).toBe(id); expect(r.content[1].text).toBe("WEBVTT\n");
  });
  it("passes detect input without inventing inline content", async () => {
    h = await harness(); mswServer.use(http.post(`${API}/v1/detect`, () => HttpResponse.json({ format: "SubRip", id: "subrip", encoding: "utf-8", encodingConfidence: "utf8-valid", paragraphs: 1 })));
    const r = await callTool(h, "detect_format", { input: "s3://subs/in/a.srt" });
    expect(r.isError).toBeFalsy(); expect(recorded.find((x) => x.path === "/v1/detect")!.body).toEqual({ input: "s3://subs/in/a.srt" });
  });
  it("rejects ambiguous sources and destinations before converting", async () => {
    h = await harness();
    for (const args of [{ content: SRT, input: "s3://subs/a.srt" }, { input: "s3://subs/a.srt", output: "s3://subs/o.vtt", outputPath: "/tmp/o.vtt" }])
      expect((await callTool(h, "convert_subtitle", { ...args, target: "vtt" })).isError).toBe(true);
    expect(recorded.some((x) => x.path === "/v1/convert/json")).toBe(false);
  });
  it("does not follow an external Location with API credentials", async () => {
    h = await harness({ apiKey: "only-the-api" }); mswServer.use(http.post(`${API}/v1/convert/json`, () => accepted("https://other.example.com/steal")));
    const r = await callTool(h, "convert_subtitle", { content: SRT, target: "vtt" });
    expect(r.structuredContent.error.code).toBe("api-protocol-error"); expect(recorded.some((x) => x.url.includes("other.example.com"))).toBe(false);
  });
  it("maps failed jobs and treats expired records as gone, without a new POST", async () => {
    h = await harness(); await h.client.listTools(); mswServer.use(http.post(`${API}/v1/convert/json`, () => accepted()), http.get(`${API}${location}`, () => HttpResponse.json({ id, status: "failed", error: { status: 502, code: "storage-io-failed", detail: "write failed", hint: "check destination" } })));
    const r = await callTool(h, "convert_subtitle", { input: "s3://subs/a.srt", target: "vtt" });
    expect(r.structuredContent.error).toMatchObject({ code: "storage-io-failed", jobId: id });
    mswServer.use(http.get(`${API}${location}`, () => HttpResponse.json({ code: "not-found" }, { status: 404 })));
    const gone = await callTool(h, "convert_subtitle", { content: SRT, target: "vtt" });
    expect(gone.structuredContent.error.code).toBe("job-gone"); expect(recorded.filter((x) => x.path === "/v1/convert/json")).toHaveLength(2);
  });
  it("metadata-only completion warns instead of inventing empty content", async () => {
    h = await harness(); mswServer.use(http.post(`${API}/v1/convert/json`, () => accepted()), http.get(`${API}${location}`, () => HttpResponse.json({ id, status: "succeeded", result: metadata() })));
    const r = await callTool(h, "convert_subtitle", { content: SRT, target: "vtt" });
    expect(r.structuredContent.warnings.some((w: any) => w.code === "output-not-retained")).toBe(true); expect(r.content).toHaveLength(1);
  });
  it("metadata-only completion cannot create an empty MCP-local output", async () => {
    const dir = tmpDir("job-local-");
    try {
      h = await harness({}, { roots: await realpathRoots([dir], []) });
      mswServer.use(http.post(`${API}/v1/convert/json`, () => accepted()), http.get(`${API}${location}`, () => HttpResponse.json({ id, status: "succeeded", result: metadata() })));
      const out = path.join(dir, "show.vtt");
      const r = await callTool(h, "convert_subtitle", { content: SRT, target: "vtt", outputPath: out });
      expect(r.structuredContent.error).toMatchObject({ code: "output-not-retained", jobId: id }); expect(fs.existsSync(out)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("does not replay a conversion POST after a connection reset", async () => {
    let posts = 0;
    h = await harness({}, { fetchImpl: async (...args) => {
      if (String(args[0]).includes("/v1/convert/json")) { posts++; throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" }); }
      return fetch(...args);
    } });
    const r = await callTool(h, "convert_subtitle", { content: SRT, target: "vtt" });
    expect(r.structuredContent.error.code).toBe("api-unreachable"); expect(posts).toBe(1);
    expect(r.structuredContent.error.hint).toContain("not replayed");
  });
  it("bounds polling time and returns the job id on timeout", async () => {
    h = await harness({ timeoutMs: 200 }); mswServer.use(http.post(`${API}/v1/convert/json`, () => HttpResponse.json({ id }, { status: 202, headers: { Location: location, "Retry-After": "10" } })));
    const r = await callTool(h, "convert_subtitle", { content: SRT, target: "vtt" });
    expect(r.structuredContent.error).toMatchObject({ code: "mcp-timeout", jobId: id, jobUrl: location }); expect(recorded.filter((x) => x.path === "/v1/convert/json")).toHaveLength(1);
  });
});
