import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { API, baseHandlers, callTool, convertOk, harness, mswServer, recorded, SRT, type Harness } from "../helpers/harness.js";
import { apiInfo } from "../../src/api/info.js";

beforeAll(() => mswServer.listen({ onUnhandledFrame: "error" }));
afterAll(() => mswServer.close());
let h: Harness | undefined;
beforeEach(() => {
  recorded.length = 0; apiInfo.probedAt = Date.now(); apiInfo.versionMismatch = false;
  mswServer.use(...baseHandlers());
});
afterEach(async () => { await h?.close(); h = undefined; mswServer.resetHandlers(); });

const id = "job_42";
const path = `/v1/jobs/${id}`;
const result = (output?: string) => {
  const r: any = convertOk([{ fileName: "show.vtt", content: "WEBVTT\n" }], { warnings: [{ code: "lossy-format", message: "m" }] });
  delete r.outputs[0].content; r.outputs[0].bytes = 7;
  if (output) r.outputs[0].output = output;
  return r;
};
const record = (over: Record<string, unknown> = {}) => ({ id, status: "succeeded", createdAt: "2026-11-12T10:00:00Z", finishedAt: "2026-11-12T10:01:00Z", output: "s3://subs/out/show.vtt", outputReplayable: true, result: result("s3://subs/out/show.vtt"), ...over });
const jobCalls = () => recorded.filter((r) => r.path.startsWith("/v1/jobs") || r.path.startsWith("/v1/convert"));

describe("get_job", () => {
  it("is read-only and idempotent, and declares an outputSchema", async () => {
    h = await harness();
    const t = (await h.client.listTools()).tools.find((x) => x.name === "get_job")!;
    expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(t.outputSchema).toBeDefined();
    expect(Object.keys(t.inputSchema.properties!).sort()).toEqual(["jobId", "wait"]);
  });

  it.each([[[], undefined], [[{ code: "lossy-format", message: "m" }], "Tell the user about this warning before anything else; its `hint`, if any, says how to fix it. "],
    [[{ code: "lossy-format", message: "m" }, { code: "zero-length-cue", message: "z" }], "Tell the user about these 2 warnings before anything else; a warning's `hint` says how to fix it. "]])("a succeeded job's hint starts with the warnings only when there are some (%j)", async (warnings, start) => {
    h = await harness();
    const rec: any = record(); rec.result.warnings = warnings;
    mswServer.use(http.get(`${API}${path}`, () => HttpResponse.json(rec)));
    const hint: string = (await callTool(h, "get_job", { jobId: id })).structuredContent.hint;
    if (start) expect(hint.startsWith(start)).toBe(true); else expect(hint).not.toMatch(/warning/i);
    expect(hint).toContain(`preview_text {jobId:"${id}", which:"output"}`);
  });

  it("waits for a running job, honouring Retry-After, using only GET /v1/jobs/{id}", async () => {
    h = await harness(); let polls = 0;
    mswServer.use(http.get(`${API}${path}`, () => (++polls < 3 ? HttpResponse.json({ id, status: "running" }, { headers: { "Retry-After": "0", Location: "https://elsewhere.example/steal" } }) : HttpResponse.json(record()))));
    const r = await callTool(h, "get_job", { jobId: id });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ jobId: id, status: "succeeded", output: "s3://subs/out/show.vtt", outputs: [{ fileName: "show.vtt", output: "s3://subs/out/show.vtt", bytes: 7 }], warnings: [{ code: "lossy-format" }] });
    expect(r.structuredContent.hint).toContain(`preview_text {jobId:"${id}", which:"output"}`);
    expect(polls).toBe(3);
    expect(jobCalls().map((x) => `${x.method} ${x.path}`)).toEqual([`GET ${path}`, `GET ${path}`, `GET ${path}`]);
    expect(recorded.some((x) => new URL(x.url).hostname === "elsewhere.example")).toBe(false);
  });

  it("wait:false checks once and reports a running job as a normal result", async () => {
    h = await harness();
    mswServer.use(http.get(`${API}${path}`, () => HttpResponse.json({ id, status: "running", createdAt: "2026-11-12T10:00:00Z" })));
    const r = await callTool(h, "get_job", { jobId: id, wait: false });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ jobId: id, status: "running", warnings: [] });
    expect(r.structuredContent.hint).toMatch(/get_job .* again.*Don't resubmit/);
    expect(jobCalls()).toHaveLength(1);
  });

  it("stops at the call's time limit and still answers running", async () => {
    h = await harness({ timeoutMs: 1500 });
    mswServer.use(http.get(`${API}${path}`, () => HttpResponse.json({ id, status: "running" }, { headers: { "Retry-After": "1" } })));
    const started = Date.now();
    const r = await callTool(h, "get_job", { jobId: id });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(r.isError).toBeFalsy(); expect(r.structuredContent.status).toBe("running");
  });

  it("says plainly that a job without an output location can't give its file back", async () => {
    h = await harness();
    mswServer.use(http.get(`${API}${path}`, () => HttpResponse.json(record({ output: undefined, result: result() }))));
    const r = await callTool(h, "get_job", { jobId: id });
    expect(r.structuredContent.status).toBe("succeeded");
    expect(r.structuredContent.hint).toMatch(/kept only this metadata.*can't be recovered.*API `output`/);
  });

  it("points out that a presigned HTTPS output can't be read back", async () => {
    h = await harness();
    mswServer.use(http.get(`${API}${path}`, () => HttpResponse.json(record({ output: "https://bucket.example/out.vtt", outputReplayable: false, result: result("https://bucket.example/out.vtt") }))));
    const r = await callTool(h, "get_job", { jobId: id });
    expect(r.structuredContent.hint).toContain("can't be read back");
  });

  it("reports truncated metadata without failing", async () => {
    h = await harness();
    mswServer.use(http.get(`${API}${path}`, () => HttpResponse.json(record({ result: { metadataTruncated: true, stats: { paragraphsIn: 9 } } }))));
    const r = await callTool(h, "get_job", { jobId: id });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ status: "succeeded", metadataTruncated: true, stats: { paragraphsIn: 9 } });
    expect(r.structuredContent.hint).toMatch(/only a summary.*preview_text/);
  });

  it("returns a failed job's conversion error with the job id", async () => {
    h = await harness();
    mswServer.use(http.get(`${API}${path}`, () => HttpResponse.json({ id, status: "failed", error: { status: 422, code: "frame-rate-required", detail: "needs fps", hint: "set source.fps" } })));
    const r = await callTool(h, "get_job", { jobId: id });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toMatchObject({ code: "frame-rate-required", jobId: id, jobStatus: "failed" }); expect(r.structuredContent.error.hint).toMatch(/^set source.fps/);
    expect(r.structuredContent.error.hint).toMatch(/The job failed; calling get_job again returns the same error. Fix the input as described and convert again.$/);
  });

  it("explains a gone record without suggesting a blind resubmit", async () => {
    h = await harness();
    mswServer.use(http.get(`${API}${path}`, () => HttpResponse.json({ code: "job-not-found" }, { status: 404 })));
    const r = await callTool(h, "get_job", { jobId: id });
    expect(r.structuredContent.error).toMatchObject({ code: "job-not-found", jobId: id });
    expect(r.structuredContent.error.hint).toMatch(/not a failed conversion.*list_files \/ preview_text \{location\}.*Don't resubmit/);
  });

  it("rejects ids that aren't job ids before any request", async () => {
    h = await harness();
    for (const jobId of ["../limits", "a/b", "", "x".repeat(129)]) {
      const r = await callTool(h, "get_job", { jobId });
      expect(r.structuredContent.error.code, jobId).toBe("invalid-arguments");
    }
    expect(jobCalls()).toHaveLength(0);
  });

  it("is what convert_subtitle's job-not-ready hint points to", async () => {
    h = await harness({ timeoutMs: 200 });
    mswServer.use(http.post(`${API}/v1/convert/json`, () => HttpResponse.json({ id }, { status: 202, headers: { Location: path, "Retry-After": "10" } })));
    const r = await callTool(h, "convert_subtitle", { content: SRT, target: "vtt", output: "s3://subs/out/a.vtt" });
    expect(r.structuredContent.error).toMatchObject({ code: "job-not-ready", jobId: id });
    expect(r.structuredContent.error.hint).toContain(`get_job {jobId:"${id}"}`);
  });
});

describe("SUBTITLE_MCP_TIMEOUT_MS is one limit per call", () => {
  it("a busy API can't push a pipeline convert_subtitle past it: retries, the POST and polls share the deadline", async () => {
    h = await harness({ timeoutMs: 2500 });
    mswServer.use(
      http.post(`${API}/v1/convert/json`, () => HttpResponse.json({ id }, { status: 202, headers: { Location: path, "Retry-After": "1" } })),
      http.get(`${API}${path}`, () => HttpResponse.json({ id, status: "running" }, { headers: { "Retry-After": "1" } })),
    );
    const started = Date.now();
    const r = await callTool(h, "convert_subtitle", { content: SRT, target: "vtt", output: "s3://subs/out/a.vtt" });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.structuredContent.error).toMatchObject({ code: "job-not-ready", jobId: id });
    expect(recorded.find((x) => x.path === "/v1/convert/json")!.headers.prefer).toBe("wait=0");
  });
});
