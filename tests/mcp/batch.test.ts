import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { http, HttpResponse } from "msw";
import { API, baseHandlers, callTool, harness, LIMITS, mswServer, recorded, SRT, tmpDir, type Harness } from "../helpers/harness.js";
import { fakeBatchApi } from "../helpers/fakeBatchApi.js";
import { realpathRoots } from "../../src/fs/guard.js";
import { apiInfo } from "../../src/api/info.js";
import { realFsOps, type FsOps } from "../../src/fs/write.js";

/** fsOps whose staging writes fail with `code` for output names matching `re`. */
const failingOps = (re: RegExp, code: string): FsOps => ({
  ...realFsOps,
  open: (async (p: string, ...rest: any[]) => {
    const fh = await (realFsOps.open as any)(p, ...rest);
    if (re.test(path.basename(p))) {
      fh.writeFile = async () => {
        const e: NodeJS.ErrnoException = new Error(code);
        e.code = code;
        e.syscall = "write";
        throw e;
      };
    }
    return fh;
  }) as any,
});

beforeAll(() => mswServer.listen({ onUnhandledFrame: "error" }));
afterAll(() => mswServer.close());

let dir: string, inDir: string, outDir: string, h: Harness;
const put = (rel: string, content = SRT) => {
  const p = path.join(inDir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};
beforeEach(async () => {
  recorded.length = 0;
  apiInfo.version = "1.1.0";
  apiInfo.probedAt = Date.now();
  dir = fs.realpathSync(tmpDir("batch-"));
  inDir = path.join(dir, "in");
  outDir = path.join(dir, "out");
  fs.mkdirSync(inDir);
  mswServer.use(...baseHandlers());
  h = await harness({}, { roots: await realpathRoots([dir], []) });
});
afterEach(async () => {
  await h.close();
  mswServer.resetHandlers();
  fs.rmSync(dir, { recursive: true, force: true });
});
const converts = () => recorded.filter((r) => r.path === "/v1/convert/json");

const STAGE = () => path.join(dir, ".subtitle-mcp-staging");
const stagingLeft = () => (fs.existsSync(STAGE()) ? fs.readdirSync(STAGE()) : []);
const nonHealth = () => recorded.filter((x) => x.path !== "/healthz");
const rel = (p: string) => path.relative(inDir, p);
const LIM = (o: object) => http.get(`${API}/v1/limits`, () => HttpResponse.json({ ...LIMITS, zip: { ...LIMITS.zip, ...o } }));

describe("convert_batch (D-44: new outputDir, all or nothing)", () => {
  it("success: subfolders kept, local exclusions, committed atomically, failFast always sent, nothing left in staging", async () => {
    put("a.srt");
    put("s1/b.srt");
    put("nested.zip", "PK");
    put("._x.srt");
    put("__MACOSX/c.srt");
    put(".hidden.srt");
    put("old.vtt.20261017-093012.bak");
    mswServer.use(fakeBatchApi());
    const r = await callTool(h, "convert_batch", { inputDir: inDir, pattern: "**/*", outputDir: outDir, target: "webvtt" });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent;
    expect(sc.outputDir).toBe(outDir);
    expect(sc.entries.map((e: any) => [rel(e.source), e.outputs])).toEqual([
      ["a.srt", [path.join(outDir, "a.vtt")]],
      ["s1/b.srt", [path.join(outDir, "s1", "b.vtt")]],
    ]);
    expect(sc.entries[0].detected).toMatchObject({ id: "subrip", kind: "text" });
    expect(sc.excluded.map((x: any) => [rel(x.source), x.reason])).toEqual([
      ["._x.srt", "macos-metadata"],
      ["__MACOSX/c.srt", "macos-metadata"],
      ["nested.zip", "nested-zip"],
    ]);
    expect(sc.totals).toMatchObject({ files: 5, converted: 2, excluded: 3, outputs: 2, chunks: 1 });
    const body = converts()[0].body;
    expect(body).toMatchObject({ contentEncoding: "base64", responseEncoding: "base64", target: "webvtt", failFast: true });
    expect(fs.readFileSync(path.join(outDir, "s1", "b.vtt"), "utf8")).toBe("WEBVTT\ns1/b.srt\n");
    expect(stagingLeft()).toEqual([]);
    expect(r.content[0].text).toMatch(/^Converted 2 files \(2 outputs\) in 1 request → .*out \(new folder\)\. 3 files excluded \(\._x\.srt: macos-metadata/);
  });

  it("one bad file: batch-failed, nothing written, outputDir not created, failures[] with hint", async () => {
    put("a.srt");
    put("s1/b.srt");
    put("s1/bad.srt");
    put("s1/z.srt");
    mswServer.use(fakeBatchApi({ badMarker: "bad" }));
    const r = await callTool(h, "convert_batch", { inputDir: inDir, pattern: "**/*", outputDir: outDir, target: "webvtt" });
    expect(r.isError).toBe(true);
    const sc = r.structuredContent;
    expect(sc.error).toMatchObject({ source: "mcp", code: "batch-failed" });
    expect(sc.failures).toEqual([expect.objectContaining({ source: path.join(inDir, "s1", "bad.srt"), code: "format-not-detected", hint: expect.stringMatching(/profile\.source\.format/) })]);
    expect(sc).toMatchObject({ converted: 2, notAttempted: 1, excluded: [] });
    expect(sc.requestIds).toHaveLength(1);
    expect(fs.existsSync(outDir)).toBe(false);
    expect(stagingLeft()).toEqual([]);
    const text = r.content[0].text;
    expect(text).toMatch(/Batch failed; nothing was written \(.*out was not created\)\./);
    expect(text).toMatch(/bad\.srt: format-not-detected: .* Hint: /);
    expect(text).toMatch(/2 files had converted before the stop and were discarded; 1 was not attempted\. Fix the file\(s\) above and rerun the whole batch\./);
  });

  it("stops at the first failure: no further chunks are sent", async () => {
    for (const n of ["a", "bad", "c", "d"]) put(`${n}.srt`);
    mswServer.use(LIM({ maxEntries: 2 }), fakeBatchApi({ badMarker: "bad" }));
    const r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: outDir, target: "webvtt" });
    expect(converts()).toHaveLength(1);
    expect(r.structuredContent).toMatchObject({ converted: 1, notAttempted: 2 });
  });

  it("an existing outputDir (dir, file or symlink) → output-dir-exists before any API call", async () => {
    put("a.srt");
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(dir, "f"), "x");
    fs.symlinkSync(path.join(dir, "nowhere"), path.join(dir, "dangling"));
    for (const o of [outDir, path.join(dir, "f"), path.join(dir, "dangling")]) {
      const r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: o, target: "webvtt" });
      expect(r.structuredContent.error).toMatchObject({ code: "output-dir-exists", path: o, hint: expect.stringMatching(/new folder name/) });
    }
    expect(nonHealth()).toHaveLength(0);
  });

  it("removed arguments are rejected (ifExists, failFast, manifestPath)", async () => {
    put("a.srt");
    for (const extra of [{ ifExists: "archive" }, { failFast: true }, { manifestPath: path.join(dir, "m.json") }]) {
      const r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: outDir, target: "webvtt", ...extra });
      expect(r.structuredContent.error.code).toBe("invalid-arguments");
    }
    const { tools } = await h.client.listTools();
    const t = tools.find((x) => x.name === "convert_batch")!;
    expect(Object.keys(t.inputSchema.properties!)).not.toContain("ifExists");
    expect(Object.keys(t.inputSchema.properties!)).toContain("writeManifest");
    expect(t.inputSchema.required).toContain("outputDir");
    expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  });

  it("D-29: same stem in one folder → whole-call error, nothing uploaded", async () => {
    put("s1/ep1.srt");
    put("s1/EP1.vtt");
    const r = await callTool(h, "convert_batch", { inputDir: inDir, pattern: "**/*", outputDir: outDir, target: "webvtt" });
    expect(r.structuredContent.error.code).toBe("ambiguous-batch-names");
    expect(r.structuredContent.error.groups).toEqual([[path.join(inDir, "s1", "EP1.vtt"), path.join(inDir, "s1", "ep1.srt")]]);
    expect(converts()).toHaveLength(0);
  });

  it("same stem in different folders: allowed with preserveStructure, rejected flat", async () => {
    put("s1/ep1.srt");
    put("s2/ep1.srt");
    mswServer.use(fakeBatchApi());
    let r = await callTool(h, "convert_batch", { inputDir: inDir, pattern: "**/*.srt", outputDir: outDir, target: "webvtt" });
    expect(r.structuredContent.totals.converted).toBe(2);
    r = await callTool(h, "convert_batch", { inputDir: inDir, pattern: "**/*.srt", outputDir: path.join(dir, "flat"), target: "webvtt", preserveStructure: false });
    expect(r.structuredContent.error.code).toBe("ambiguous-batch-names");
    expect(r.structuredContent.error.hint).toMatch(/preserveStructure:true/);
  });

  it("a..b.srt is sent as is (D-36); a top-level manifest.json is aliased and mapped back", async () => {
    put("a..b.srt");
    put("manifest.json", "{}");
    put("ok.srt");
    mswServer.use(fakeBatchApi());
    const r = await callTool(h, "convert_batch", { inputDir: inDir, pattern: "*", outputDir: outDir, target: "webvtt" });
    const names = Object.keys((await import("fflate")).unzipSync(Buffer.from(converts()[0].body.content, "base64"))).sort();
    expect(names).toEqual(["_mcp/1.json", "a..b.srt", "ok.srt"]);
    expect(fs.existsSync(path.join(outDir, "a..b.vtt"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "manifest.vtt"))).toBe(true);
    expect(r.structuredContent.totals.converted).toBe(3);
  });

  it("size pre-checks run for all files before any upload; all precheck-too-large failures reported together", async () => {
    put("a.srt");
    put("big1.srt", "x".repeat(2000));
    put("big2.srt", "x".repeat(3000));
    mswServer.use(LIM({ maxEntryBytes: 1000 }), fakeBatchApi());
    const r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: outDir, target: "webvtt" });
    expect(r.structuredContent.error.code).toBe("batch-failed");
    expect(r.structuredContent.failures.map((f: any) => [rel(f.source), f.code])).toEqual([["big1.srt", "precheck-too-large"], ["big2.srt", "precheck-too-large"]]);
    expect(r.structuredContent).toMatchObject({ converted: 0, notAttempted: 1 });
    expect(converts()).toHaveLength(0);
    expect(stagingLeft()).toEqual([]);
  });

  it("chunks by entry limit from /v1/limits; request ids carry .c<k>; progress per chunk", async () => {
    for (let i = 0; i < 5; i++) put(`f${i}.srt`);
    mswServer.use(LIM({ maxEntries: 2 }), fakeBatchApi());
    const msgs: string[] = [];
    const r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: outDir, target: "webvtt" }, { progress: (m) => msgs.push(m) });
    expect(r.structuredContent.totals).toMatchObject({ converted: 5, chunks: 3, outputs: 5 });
    expect(converts().map((c) => c.headers["x-request-id"].replace(/^mcp-[0-9A-Z]+/, ""))).toEqual([".c1", ".c2", ".c3"]);
    expect(msgs).toEqual(["Batch: 1/3 chunks done", "Batch: 2/3 chunks done", "Batch: 3/3 chunks done"]);
  });

  it("chunks by estimated response size (target.additional from the preset)", async () => {
    for (let i = 0; i < 4; i++) put(`f${i}.srt`, "x".repeat(100_000));
    mswServer.use(
      http.get(`${API}/v1/profiles/:name`, () => HttpResponse.json({ name: "p", origin: "builtin", valid: true, errors: [], warnings: [], raw: {}, resolved: { target: { format: "webvtt", additional: ["ttml"] } } })),
      fakeBatchApi({ extraOutputs: ["ttml"] }),
    );
    await h.close();
    h = await harness({ batchMaxResponseBytes: 700_000 }, { roots: await realpathRoots([dir], []) });
    const r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: outDir, preset: "p" });
    expect(r.structuredContent.totals).toMatchObject({ chunks: 4, outputs: 8 });
    expect(fs.existsSync(path.join(outDir, "f0.ttml.vtt"))).toBe(true);
  });

  it("adaptive halving on 413", async () => {
    for (let i = 0; i < 4; i++) put(`f${i}.srt`);
    const chunks: string[][] = [];
    mswServer.use(fakeBatchApi({ max413Entries: 1, chunks }));
    const r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: outDir, target: "webvtt" });
    expect(r.structuredContent.totals.converted).toBe(4);
    expect(chunks.map((c) => c.length)).toEqual([4, 2, 1, 1, 2, 1, 1]);
  });

  it("API ambiguous-batch-names (output clash) maps groups/outputs to local paths; nothing written", async () => {
    put("a.srt");
    put("b.srt");
    mswServer.use(fakeBatchApi({ ambiguous: { groups: [["a.srt", "b.srt"]], outputs: ["out.vtt"] } }));
    const r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: outDir, target: "webvtt" });
    expect(r.isError).toBe(true);
    const e = r.structuredContent.error;
    expect(e.code).toBe("ambiguous-batch-names");
    expect(e.groups).toEqual([[path.join(inDir, "a.srt"), path.join(inDir, "b.srt")]]);
    expect(e.outputs).toEqual([path.join(outDir, "out.vtt")]);
    expect(e.errors[0].pointer).toBe(path.join(inDir, "a.srt"));
    expect(r.structuredContent.failures).toEqual([]);
    expect(fs.existsSync(outDir)).toBe(false);
    expect(stagingLeft()).toEqual([]);
  });

  it("cross-chunk output clash (template without {stem}) → whole-call ambiguous-batch-names; nothing written, no _2 file", async () => {
    put("a.srt");
    put("b.srt");
    mswServer.use(LIM({ maxEntries: 1 }), fakeBatchApi({ fixedName: "out.vtt" }));
    const r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: outDir, target: "webvtt" });
    expect(r.structuredContent.error).toMatchObject({ code: "ambiguous-batch-names", source: "mcp" });
    expect(r.structuredContent.error.groups).toEqual([[path.join(inDir, "a.srt"), path.join(inDir, "b.srt")]]);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it("an entry the API silently dropped → entry-not-converted → nothing written", async () => {
    put("a.srt");
    put("b.srt");
    mswServer.use(fakeBatchApi({ drop: "b.srt" }));
    const r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: outDir, target: "webvtt" });
    expect(r.structuredContent.error.code).toBe("batch-failed");
    expect(r.structuredContent.failures).toEqual([expect.objectContaining({ source: path.join(inDir, "b.srt"), code: "entry-not-converted" })]);
    expect(r.structuredContent.converted).toBe(1);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it("whole-request errors fail the batch with their own code (invalid-profile), failures[] empty", async () => {
    put("a.srt");
    mswServer.use(http.post(`${API}/v1/convert/json`, () => HttpResponse.json({ status: 400, code: "invalid-profile", title: "Invalid profile", detail: "d", hint: "h", errors: [{ pointer: "/target/format", message: "Unknown" }] }, { status: 400, headers: { "Content-Type": "application/problem+json" } })));
    const r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: outDir, profile: { target: { format: "nope" } } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error.code).toBe("invalid-profile");
    expect(r.structuredContent).toMatchObject({ failures: [], converted: 0, notAttempted: 1 });
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it("paths mode: duplicates removed, artifacts excluded; writeManifest puts the report inside outputDir", async () => {
    const a = put("a.srt");
    put("x.vtt.20261017-093012.bak");
    mswServer.use(fakeBatchApi());
    const r = await callTool(h, "convert_batch", { paths: [a, a, path.join(inDir, "x.vtt.20261017-093012.bak")], outputDir: outDir, target: "webvtt", writeManifest: true });
    expect(r.structuredContent.excluded).toEqual([{ source: path.join(inDir, "x.vtt.20261017-093012.bak"), reason: "mcp-artifact" }]);
    expect(r.structuredContent.entries).toHaveLength(1);
    expect(r.structuredContent.manifestPath).toBe(path.join(outDir, "subtitle-mcp-manifest.json"));
    const m = JSON.parse(fs.readFileSync(path.join(outDir, "subtitle-mcp-manifest.json"), "utf8"));
    expect(m.totals.converted).toBe(1);
    expect(fs.readdirSync(outDir).sort()).toEqual(["a.vtt", "subtitle-mcp-manifest.json"]);
  });

  it("an output named like the manifest → ambiguous-batch-names, nothing written", async () => {
    put("a.srt");
    mswServer.use(fakeBatchApi({ fixedName: "subtitle-mcp-manifest.json" }));
    const r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: outDir, target: "webvtt", writeManifest: true });
    expect(r.structuredContent.error.code).toBe("ambiguous-batch-names");
    expect(fs.existsSync(outDir)).toBe(false);
    expect(stagingLeft()).toEqual([]);
  });

  it("paths mode: a disallowed path is a failure, so nothing is sent", async () => {
    const a = put("a.srt");
    mswServer.use(fakeBatchApi());
    const r = await callTool(h, "convert_batch", { paths: [a, "/etc/passwd"], outputDir: outDir, target: "webvtt" });
    expect(r.structuredContent.error.code).toBe("batch-failed");
    expect(r.structuredContent.failures.map((f: any) => [f.source, f.code])).toEqual([["/etc/passwd", "path-not-allowed"]]);
    expect(converts()).toHaveLength(0);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it("no files matched / too many files / exactly one of inputDir|paths", async () => {
    let r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: outDir, target: "webvtt" });
    expect(r.structuredContent.error).toMatchObject({ code: "invalid-arguments" });
    r = await callTool(h, "convert_batch", { outputDir: outDir, target: "webvtt" });
    expect(r.structuredContent.error.code).toBe("invalid-arguments");
    put("a.srt");
    put("b.srt");
    await h.close();
    h = await harness({ batchMaxFiles: 1 }, { roots: await realpathRoots([dir], []) });
    r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: outDir, target: "webvtt" });
    expect(r.structuredContent.error.detail).toMatch(/More than 1 files/);
    expect(converts()).toHaveLength(0);
  });

  it("symlinks escaping the roots are excluded (path-not-allowed); the batch still commits (OQ-45)", async () => {
    put("a.srt");
    const outside = tmpDir("outside-");
    fs.writeFileSync(path.join(outside, "s.srt"), SRT);
    fs.symlinkSync(path.join(outside, "s.srt"), path.join(inDir, "link.srt"));
    mswServer.use(fakeBatchApi());
    const r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: outDir, target: "webvtt" });
    expect(r.structuredContent.excluded).toEqual([{ source: path.join(inDir, "link.srt"), reason: "path-not-allowed" }]);
    expect(fs.existsSync(path.join(outDir, "a.vtt"))).toBe(true);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("D-38: the staging folder is never selected; inputDir/outputDir inside it are refused", async () => {
    put("a.srt");
    fs.mkdirSync(path.join(inDir, ".subtitle-mcp-staging"));
    fs.writeFileSync(path.join(inDir, ".subtitle-mcp-staging", "y.srt"), SRT);
    mswServer.use(fakeBatchApi());
    const r = await callTool(h, "convert_batch", { inputDir: inDir, pattern: "**/*", outputDir: outDir, target: "webvtt" });
    expect(r.structuredContent.entries.map((e: any) => rel(e.source))).toEqual(["a.srt"]);
    const p = await callTool(h, "convert_batch", { paths: [path.join(inDir, ".subtitle-mcp-staging", "y.srt"), path.join(inDir, "a.srt")], outputDir: path.join(dir, "o2"), target: "webvtt" });
    expect(p.structuredContent.excluded).toEqual([{ source: path.join(inDir, ".subtitle-mcp-staging", "y.srt"), reason: "mcp-artifact" }]);
    const d = await callTool(h, "convert_batch", { inputDir: path.join(inDir, ".subtitle-mcp-staging"), outputDir: path.join(dir, "o3"), target: "webvtt" });
    expect(d.structuredContent.error.code).toBe("path-not-allowed");
    const o = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: path.join(dir, ".subtitle-mcp-staging", "x"), target: "webvtt" });
    expect(o.structuredContent.error.code).toBe("path-not-allowed");
  });

  it("staging lives at <output-root>/.subtitle-mcp-staging/<dirname>.<6hex>.partial/; parents are created only at commit", async () => {
    put("a.srt");
    const seen: string[] = [];
    const ops: FsOps = { ...realFsOps, open: (async (p: string, ...rest: any[]) => (seen.push(p), (realFsOps.open as any)(p, ...rest))) as any };
    await h.close();
    h = await harness({}, { roots: await realpathRoots([dir], []), fsOps: ops });
    const deep = path.join(dir, "new", "deep", "out");
    let parentDuringConvert = true;
    let stagingDuringConvert: string[] = [];
    const fake = fakeBatchApi();
    mswServer.use(
      http.post(`${API}/v1/convert/json`, async (info) => {
        parentDuringConvert = fs.existsSync(path.join(dir, "new"));
        stagingDuringConvert = stagingLeft();
        return (fake as any).resolver(info);
      }),
    );
    const r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: deep, target: "webvtt" });
    expect(r.isError).toBeFalsy();
    expect(parentDuringConvert).toBe(false);
    expect(stagingDuringConvert).toEqual([expect.stringMatching(/^out\.[0-9a-f]{6}\.partial$/)]);
    expect(path.relative(STAGE(), seen[0])).toMatch(/^out\.[0-9a-f]{6}\.partial\/a\.vtt$/);
    expect(fs.readdirSync(deep)).toEqual(["a.vtt"]);
    expect(stagingLeft()).toEqual([]);
  });

  it("a failed batch never creates outputDir's missing parents", async () => {
    put("bad.srt");
    mswServer.use(fakeBatchApi({ badMarker: "bad" }));
    await callTool(h, "convert_batch", { inputDir: inDir, outputDir: path.join(dir, "new", "deep", "out"), target: "webvtt" });
    expect(fs.existsSync(path.join(dir, "new"))).toBe(false);
  });

  it("the staging folder's mtime is refreshed after each chunk", async () => {
    for (let i = 0; i < 3; i++) put(`f${i}.srt`);
    const mtimes: number[] = [];
    const fake = fakeBatchApi();
    mswServer.use(
      LIM({ maxEntries: 1 }),
      http.post(`${API}/v1/convert/json`, async (info) => {
        const [d] = stagingLeft();
        const p = path.join(STAGE(), d);
        mtimes.push(fs.statSync(p).mtimeMs);
        const old = new Date(Date.now() - 3600_000);
        fs.utimesSync(p, old, old); // pretend it aged; the MCP must refresh it after the chunk
        return (fake as any).resolver(info);
      }),
    );
    await callTool(h, "convert_batch", { inputDir: inDir, outputDir: outDir, target: "webvtt" });
    expect(mtimes).toHaveLength(3);
    for (const m of mtimes.slice(1)) expect(Date.now() - m).toBeLessThan(60_000);
  });

  it("D-41: outputDir's nearest existing ancestor on another device than the staging folder → cross-device before any conversion", async () => {
    put("a.srt");
    fs.mkdirSync(path.join(dir, "mnt"));
    const ops: FsOps = {
      ...realFsOps,
      stat: async (p) => {
        const st = await realFsOps.stat(p);
        return p === path.join(dir, "mnt") ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 1 }) : st;
      },
    };
    await h.close();
    h = await harness({}, { roots: await realpathRoots([dir], []), fsOps: ops });
    const r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: path.join(dir, "mnt", "x", "out"), target: "webvtt" });
    expect(r.structuredContent.error).toMatchObject({ code: "cross-device", path: path.join(dir, "mnt", "x", "out") });
    expect(r.structuredContent.error.hint).toMatch(/own output root/);
    expect(converts()).toHaveLength(0);
    expect(stagingLeft()).toEqual([]);
  });

  it("D-35: a local write failure → batch-failed with path, osError and hint; stops further chunks; nothing written", async () => {
    for (const n of ["a", "b", "c", "d"]) put(`${n}.srt`);
    await h.close();
    h = await harness({}, { roots: await realpathRoots([dir], []), fsOps: failingOps(/^b\.vtt$/, "ENOSPC") });
    mswServer.use(LIM({ maxEntries: 2 }), fakeBatchApi());
    const r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: outDir, target: "webvtt" });
    expect(r.structuredContent.error.code).toBe("batch-failed");
    expect(r.structuredContent.failures).toEqual([
      expect.objectContaining({ source: path.join(inDir, "b.srt"), code: "disk-full", path: path.join(outDir, "b.vtt"), osError: expect.objectContaining({ code: "ENOSPC", syscall: "write" }), hint: expect.stringMatching(/Free space/) }),
    ]);
    expect(r.structuredContent).toMatchObject({ converted: 1, notAttempted: 2 });
    expect(converts()).toHaveLength(1);
    expect(r.content[0].text).toMatch(/b\.vtt: disk-full \(ENOSPC\): /);
    expect(fs.existsSync(outDir)).toBe(false);
    expect(stagingLeft()).toEqual([]);
  });

  it("an outputDir that appears during conversion → output-dir-exists, staging removed, the new folder untouched", async () => {
    put("a.srt");
    const fake = fakeBatchApi();
    mswServer.use(
      http.post(`${API}/v1/convert/json`, async (info) => {
        fs.mkdirSync(outDir);
        fs.writeFileSync(path.join(outDir, "theirs.txt"), "x");
        return (fake as any).resolver(info);
      }),
    );
    const r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: outDir, target: "webvtt" });
    expect(r.structuredContent.error).toMatchObject({ code: "output-dir-exists", path: outDir });
    expect(fs.readdirSync(outDir)).toEqual(["theirs.txt"]);
    expect(stagingLeft()).toEqual([]);
  });

  it("frame-rate-changed is listed right after the first summary line", async () => {
    put("a.stl", "x");
    put("b.stl", "x");
    mswServer.use(
      http.post(`${API}/v1/convert/json`, async () =>
        HttpResponse.json({
          outputs: ["a", "b"].map((n) => ({ fileName: `${n}.stl`, format: "EBU STL", formatId: "ebustl", mediaType: "application/octet-stream", content: "AAAA", contentEncoding: "base64", encoding: "binary", cues: 1, source: `${n}.stl`, kind: "binary" })),
          detected: null, stats: { paragraphsIn: 2, paragraphsOut: 2 }, warnings: [], profile: {},
          entries: ["a", "b"].map((n) => ({ source: `${n}.stl`, status: "ok", outputs: [`${n}.stl`], warnings: [{ code: "frame-rate-changed", message: "Source 29.97 fps written as STL30.01" }] })),
        }),
      ),
    );
    const r = await callTool(h, "convert_batch", { inputDir: inDir, outputDir: outDir, target: "ebustl" });
    expect(r.content[0].text.split("\n")[1]).toBe("Frame rate changed on 2 files: Source 29.97 fps written as STL30.01");
  });
});
