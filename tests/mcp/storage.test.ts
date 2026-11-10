/**
 * Browse and read by location: SUBTITLE_MCP_LIST_ENABLED × the API's STORAGE_LIST_ENABLED (GET /v1/limits storage.list),
 * list_allowed_folders remote section, list_files (local and API), preview_text {location}. Mocked API; deterministic fixtures.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { Ajv } from "ajv";
import { API, EXTENSIONS, LIMITS, SRT, baseHandlers, callTool, convertOk, harness, mswServer, problem, recorded, tmpDir, type Harness } from "../helpers/harness.js";
import { realpathRoots } from "../../src/fs/guard.js";
import { apiInfo } from "../../src/api/info.js";
import { longSrt, occurrences, probe } from "../helpers/fixtures.js";

let h: Harness | undefined;
let dir: string, outside: string;
const LOCATIONS = [
  { uri: "file:///data/subs/", scheme: "file", listable: true, readable: true },
  { uri: "s3://subs/in/", scheme: "s3", listable: true, readable: true },
  { uri: "s3://subs/out/", scheme: "s3", listable: true, readable: true, prefix: "show" },
  { uri: "https://mam.example.com/", scheme: "https", listable: false, readable: false, note: "Convert input/output only." },
];
const limits = (list: boolean | undefined) => ({ ...LIMITS, storage: { extensions: EXTENSIONS, inputSchemes: ["file", "s3"], outputSchemes: ["file", "s3"], ...(list === undefined ? {} : { list, listSchemes: list ? ["file", "s3"] : [] }) } });
const enc = (s: string) => Buffer.from(s).toString("base64url");

/** API storage mock: 450 keys under s3://subs/in/, pages of 200 with an opaque cursor; files served by /v1/storage/file. */
function apiStorage(opts: { list?: boolean; files?: Record<string, Buffer> } = {}) {
  const names = [...Array.from({ length: 450 }, (_, i) => `show_${String(i).padStart(3, "0")}.srt`), "season1/"].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  mswServer.use(
    http.get(`${API}/v1/limits`, () => HttpResponse.json(limits(opts.list ?? true))),
    http.get(`${API}/v1/storage/locations`, () => opts.list === false ? problem(403, "storage-list-disabled") : HttpResponse.json({ locations: LOCATIONS })),
    http.get(`${API}/v1/storage/list`, ({ request }) => {
      if (opts.list === false) return problem(403, "storage-list-disabled");
      const q = new URL(request.url).searchParams;
      if (q.get("location") === "https://mam.example.com/") return problem(422, "storage-not-listable");
      const prefix = q.get("prefix") ?? "", cursor = q.get("cursor");
      const after = cursor ? Buffer.from(cursor, "base64url").toString() : undefined;
      if (cursor && !after?.startsWith("show_")) return problem(400, "storage-cursor-invalid");
      const all = names.filter((n) => n.startsWith(prefix) && (!after || Buffer.compare(Buffer.from(n), Buffer.from(after)) > 0));
      const page = all.slice(0, 200), more = all.length > 200;
      return HttpResponse.json({ location: q.get("location"), prefix, items: page.map((n) => ({ name: n, uri: `s3://subs/in/${n}`, type: n.endsWith("/") ? "folder" : "file", ...(n.endsWith("/") ? {} : { size: 42, modified: "2026-01-02T03:04:05+00:00" }) })), returned: page.length, truncated: more, ...(more ? { next: enc(page[page.length - 1]) } : {}) });
    }),
    http.get(`${API}/v1/storage/file`, ({ request }) => {
      if (opts.list === false) return problem(403, "storage-list-disabled");
      const loc = new URL(request.url).searchParams.get("location")!;
      const f = opts.files?.[loc];
      return f ? new HttpResponse(f, { headers: { "content-type": "application/octet-stream" } }) : problem(404, "storage-not-found");
    }),
  );
}

const mk = async (listEnabled: boolean, extra: Record<string, unknown> = {}) => harness({ listEnabled, ...extra }, { roots: await realpathRoots([dir], []) });
const storageCalls = () => recorded.filter((r) => r.path.startsWith("/v1/storage/"));

beforeAll(() => mswServer.listen({ onUnhandledFrame: "error" })); afterAll(() => mswServer.close());
beforeEach(() => {
  recorded.length = 0; apiInfo.probedAt = Date.now(); mswServer.use(...baseHandlers());
  dir = tmpDir("mcp-list-"); outside = tmpDir("mcp-outside-");
  fs.writeFileSync(path.join(outside, "secret.srt"), "1\n00:00:01,000 --> 00:00:02,000\nSECRET\n");
});
afterEach(async () => { await h?.close(); h = undefined; mswServer.resetHandlers(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });

describe("gates", () => {
  it("default (SUBTITLE_MCP_LIST_ENABLED unset): list_files shown, preview_text leads with the full-URI location, remote follows the API", async () => {
    apiStorage({ list: true });
    h = await harness({}, { roots: await realpathRoots([dir], []) });
    const tools = (await h.client.listTools()).tools;
    expect(tools.map((t) => t.name)).toContain("list_files");
    const preview = tools.find((t) => t.name === "preview_text")!;
    expect(preview.description).toMatch(/^Read the subtitle text of a file\. `location` takes the file's full URI \(s3:\/\/bucket\/key or file:\/\/\/path/);
    expect(preview.description).toContain("s3://subs/show.srt.json");
    expect((preview.inputSchema.properties as any).location.description).toMatch(/^The file's full URI or absolute path/);
    const listed = await callTool(h, "list_files", { location: "s3://subs/in/" });
    expect(listed.content[0].text).toMatch(/pass its full items\[\]\.location as preview_text `location` \(e\.g\. s3:\/\/subs\/in\//);
    await h.close();
    mswServer.resetHandlers(); mswServer.use(...baseHandlers()); apiStorage({ list: false });
    h = await harness({}, { roots: await realpathRoots([dir], []) });
    const off = await callTool(h, "list_files", { location: "s3://subs/in/" });
    expect(off.structuredContent.error.code).toBe("storage-list-disabled");
    expect(off.structuredContent.error.hint).toContain("STORAGE_LIST_ENABLED=true");
  });
  it("MCP off (SUBTITLE_MCP_LIST_ENABLED=false): no list_files, no preview_text location, no remote section and no /v1/storage calls; job previews work", async () => {
    apiStorage({ list: true });
    h = await mk(false);
    const tools = (await h.client.listTools()).tools;
    expect(tools.map((t) => t.name)).not.toContain("list_files");
    const preview = tools.find((t) => t.name === "preview_text")!;
    expect(Object.keys(preview.inputSchema.properties!)).not.toContain("location");
    expect(preview.inputSchema.required).toEqual(expect.arrayContaining(["jobId", "which"]));
    const folders = await callTool(h, "list_allowed_folders", {});
    expect(folders.structuredContent.remote).toBeUndefined();
    expect(JSON.stringify(folders)).not.toContain("s3://subs");
    const r = await callTool(h, "preview_text", { location: path.join(dir, "a.srt") });
    expect(r.structuredContent.error.code).toBe("invalid-arguments");
    expect(storageCalls()).toEqual([]);
    mswServer.use(http.get(`${API}/v1/jobs/:id`, () => HttpResponse.json({ id: "j1", status: "succeeded", input: "s3://subs/in/a.srt", result: { detected: { id: "subrip", encoding: "utf-8", kind: "text" } } })),
      http.get(`${API}/v1/jobs/:id/input`, () => new HttpResponse(SRT)));
    const job = await callTool(h, "preview_text", { jobId: "j1", which: "input" });
    expect(job.isError).toBeFalsy(); expect(job.structuredContent).toMatchObject({ source: "job", text: SRT });
  });

  it("MCP on, API off: local browsing and reading work; remote is explained without listing or leaking allowlists", async () => {
    apiStorage({ list: false });
    fs.writeFileSync(path.join(dir, "a.srt"), SRT);
    h = await mk(true);
    expect((await h.client.listTools()).tools.map((t) => t.name)).toContain("list_files");
    const folders = await callTool(h, "list_allowed_folders", {});
    expect(folders.structuredContent.remote).toMatchObject({ state: "disabled-api", locations: [] });
    expect(folders.structuredContent.remote.hint).toContain("STORAGE_LIST_ENABLED=true");
    expect(folders.structuredContent.folders.map((f: any) => f.path)).toEqual([dir]);
    const list = await callTool(h, "list_files", { location: "s3://subs/in/" });
    expect(list.structuredContent.error).toMatchObject({ code: "storage-list-disabled" });
    const read = await callTool(h, "preview_text", { location: "s3://subs/in/a.srt" });
    expect(read.structuredContent.error.code).toBe("storage-list-disabled");
    expect(storageCalls()).toEqual([]); // never list (or read) just to say no
    for (const r of [folders, list, read]) expect(JSON.stringify(r)).not.toMatch(/data\/subs|mam\.example/);
    const local = await callTool(h, "list_files", { location: dir });
    expect(local.structuredContent).toMatchObject({ where: "local", items: [{ name: "a.srt", type: "file", size: SRT.length }] });
    const text = await callTool(h, "preview_text", { location: local.structuredContent.items[0].location });
    expect(text.structuredContent).toMatchObject({ source: "local", text: SRT, location: path.join(dir, "a.srt") });
  });

  it("MCP on, API on: remote locations are shown; an older API without storage.list counts as off; unreachable is unknown", async () => {
    apiStorage({ list: true });
    h = await mk(true);
    const on = await callTool(h, "list_allowed_folders", {});
    expect(on.structuredContent.remote.state).toBe("on");
    expect(on.structuredContent.remote.locations).toEqual([
      { location: "file:///data/subs/", scheme: "file", listable: true, readable: true },
      { location: "s3://subs/in/", scheme: "s3", listable: true, readable: true },
      { location: "s3://subs/out/", scheme: "s3", listable: true, readable: true, prefix: "show" },
      { location: "https://mam.example.com/", scheme: "https", listable: false, readable: false, note: "Convert input/output only." },
    ]);
    await h.close();
    mswServer.use(http.get(`${API}/v1/limits`, () => HttpResponse.json(limits(undefined))));
    h = await mk(true);
    expect((await callTool(h, "list_allowed_folders", {})).structuredContent.remote.state).toBe("disabled-api");
    await h.close();
    mswServer.use(http.get(`${API}/v1/limits`, () => HttpResponse.error()));
    h = await mk(true);
    const unknown = await callTool(h, "list_allowed_folders", {});
    expect(unknown.structuredContent.remote.state).toBe("unknown");
    expect((await callTool(h, "list_files", { location: "s3://subs/in/" })).structuredContent.error.code).toBe("api-unreachable");
  });

  it("a stale MCP (API switched off since its limits were read) gets the API's refusal with a clear hint and re-reads the capability", async () => {
    apiStorage({ list: true });
    h = await mk(true);
    expect((await callTool(h, "list_allowed_folders", {})).structuredContent.remote.state).toBe("on");
    apiStorage({ list: false });
    mswServer.use(http.get(`${API}/v1/limits`, () => HttpResponse.json(limits(false))));
    const r = await callTool(h, "list_files", { location: "s3://subs/in/" });
    expect(r.structuredContent.error.code).toBe("storage-list-disabled");
    expect(r.structuredContent.error.hint).toContain("STORAGE_LIST_ENABLED=true");
    expect((await callTool(h, "list_allowed_folders", {})).structuredContent.remote.state).toBe("disabled-api");
  });
});

describe("list_files", () => {
  const walk = async (location: string, prefix?: string, between?: (page: number) => void) => {
    const names: string[] = []; const raws: any[] = []; let cursor: string | undefined; let page = 0;
    do {
      const r = await callTool(h!, "list_files", { location, ...(prefix ? { prefix } : {}), ...(cursor ? { cursor } : {}) });
      expect(r.isError, JSON.stringify(r.structuredContent?.error)).toBeFalsy();
      raws.push(r.structuredContent); names.push(...r.structuredContent.items.map((i: any) => i.name));
      expect(r.structuredContent.returned).toBe(r.structuredContent.items.length); expect(r.structuredContent.items.length).toBeLessThanOrEqual(200);
      cursor = r.structuredContent.next;
      expect(Boolean(cursor)).toBe(r.structuredContent.truncated);
      if (cursor) between?.(++page);
    } while (cursor);
    return { names, raws };
  };

  it("local walk: every entry once in UTF-8 name order; hidden, non-subtitle files, all symlinks and specials skipped", async () => {
    const expected: string[] = [];
    for (let i = 0; i < 450; i++) { const n = `show_${String(i).padStart(3, "0")}.srt`; fs.writeFileSync(path.join(dir, n), "x"); expected.push(n); }
    for (const n of ["Émission.srt", "Zebra.srt", "émission.srt", "zz-日本.srt"]) { fs.writeFileSync(path.join(dir, n), SRT); expected.push(n); }
    fs.mkdirSync(path.join(dir, "season1")); fs.writeFileSync(path.join(dir, "season1", "ep1.srt"), SRT); expected.push("season1/");
    fs.writeFileSync(path.join(dir, ".hidden.srt"), "x");
    fs.symlinkSync(path.join(outside, "secret.srt"), path.join(dir, "escape.srt"));
    fs.symlinkSync(outside, path.join(dir, "escape-dir"));
    fs.symlinkSync(path.join(dir, "show_000.srt"), path.join(dir, "inside-link.srt")); // H10: never followed, not shown
    for (const n of ["notes.pdf", "run.sh", "README", "image.PNG"]) fs.writeFileSync(path.join(dir, n), "x"); // H3: not subtitles
    fs.writeFileSync(path.join(dir, "UPPER.SRT"), SRT); expected.push("UPPER.SRT"); // case-insensitive extension
    fs.mkdirSync(path.join(dir, "folder.pdf")); expected.push("folder.pdf/"); // folders are listed whatever their name
    if (process.platform !== "win32") execFileSync("mkfifo", [path.join(dir, "pipe.srt")]);
    expected.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    h = await mk(true); apiStorage({ list: false });
    const { names, raws } = await walk(dir);
    expect(names).toEqual(expected);
    expect(raws.length).toBe(3);
    const item = raws[0].items.find((i: any) => i.name === "show_000.srt");
    expect(item).toMatchObject({ type: "file", size: 1, location: path.join(dir, "show_000.srt") });
    expect(new Date(item.modified).getTime()).toBeGreaterThan(0);
    expect((await walk(dir, "show_1")).names).toEqual(Array.from({ length: 100 }, (_, i) => `show_${100 + i}.srt`));
    expect((await walk(dir, "season1/")).names).toEqual(["ep1.srt"]);
    const folder = raws.flatMap((r) => r.items).find((i: any) => i.name === "season1/");
    expect((await walk(folder.location)).names).toEqual(["ep1.srt"]);
    expect(JSON.stringify(raws)).not.toContain("secret");
  });

  it("local walk under mutation: stable files appear exactly once", async () => {
    for (let i = 0; i < 500; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(3, "0")}.srt`), "x");
    h = await mk(true); apiStorage({ list: false });
    const { names } = await walk(dir, undefined, (page) => {
      if (page !== 1) return;
      fs.rmSync(path.join(dir, "f010.srt")); fs.rmSync(path.join(dir, "f300.srt"));
      fs.writeFileSync(path.join(dir, "f005b.srt"), "x"); fs.writeFileSync(path.join(dir, "f400b.srt"), "x");
    });
    expect(new Set(names).size).toBe(names.length);
    for (let i = 0; i < 500; i++) if (i !== 10 && i !== 300) expect(names.filter((n) => n === `f${String(i).padStart(3, "0")}.srt`)).toHaveLength(1);
    expect(names).toContain("f010.srt"); expect(names).not.toContain("f300.srt"); expect(names).not.toContain("f005b.srt"); expect(names).toContain("f400b.srt");
  });

  it("local: outside folders, traversal, outside symlinked folders and bad prefixes are refused", async () => {
    fs.symlinkSync(outside, path.join(dir, "escape-dir"));
    h = await mk(true); apiStorage({ list: false });
    const code = async (args: Record<string, unknown>) => (await callTool(h!, "list_files", args)).structuredContent.error?.code;
    expect(await code({ location: outside })).toBe("path-not-allowed");
    expect(await code({ location: path.join(dir, "..", path.basename(outside)) })).toBe("path-not-allowed");
    expect(await code({ location: path.join(dir, "escape-dir") })).toBe("path-not-allowed");
    expect(await code({ location: dir, prefix: "escape-dir/" })).toBe("path-not-allowed");
    expect(await code({ location: dir, prefix: `../${path.basename(outside)}/` })).toBe("invalid-arguments");
    expect(await code({ location: dir, prefix: "/etc" })).toBe("invalid-arguments");
    expect(await code({ location: path.join(dir, "missing") })).toBe("path-not-found");
    expect(await code({ location: "relative/folder" })).toBe("path-not-allowed");
  });

  it("API walk: pages of 200 through the API with wrapped cursors; prefix passed through; https not listable", async () => {
    apiStorage({ list: true });
    h = await mk(true);
    const { names, raws } = await walk("s3://subs/in/");
    expect(names).toHaveLength(451); expect(new Set(names).size).toBe(451);
    expect(raws[0]).toMatchObject({ where: "remote", location: "s3://subs/in/" });
    expect(raws[0].items[0]).toEqual({ name: "season1/", location: "s3://subs/in/season1/", type: "folder" });
    expect(raws[0].items[1]).toEqual({ name: "show_000.srt", location: "s3://subs/in/show_000.srt", type: "file", size: 42, modified: "2026-01-02T03:04:05+00:00" });
    const lists = recorded.filter((r) => r.path === "/v1/storage/list").map((r) => new URL(r.url).searchParams);
    expect(lists.map((q) => q.get("cursor"))).toEqual([null, enc("show_198.srt"), enc("show_398.srt")]); // the API's own cursor, unwrapped
    recorded.length = 0;
    expect((await walk("s3://subs/in/", "show_1")).names).toHaveLength(100);
    expect(new URL(recorded.find((r) => r.path === "/v1/storage/list")!.url).searchParams.get("prefix")).toBe("show_1");
    const https = await callTool(h, "list_files", { location: "https://mam.example.com/" });
    expect(https.structuredContent.error.code).toBe("storage-not-listable");
  });

  it("cursors are bound to mode, location and prefix; malformed ones never reach the API", async () => {
    apiStorage({ list: true });
    for (let i = 0; i < 260; i++) fs.writeFileSync(path.join(dir, `a${String(i).padStart(3, "0")}.srt`), "x");
    fs.mkdirSync(path.join(dir, "sub"));
    h = await mk(true);
    const local = (await callTool(h, "list_files", { location: dir })).structuredContent.next;
    const remote = (await callTool(h, "list_files", { location: "s3://subs/in/" })).structuredContent.next;
    recorded.length = 0;
    const forge = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const cases: [Record<string, unknown>, string][] = [
      [{ location: dir, cursor: remote }, "remote cursor on a local folder"],
      [{ location: "s3://subs/in/", cursor: local }, "local cursor on an API folder"],
      [{ location: dir, prefix: "a", cursor: local }, "other prefix"],
      [{ location: path.join(dir, "sub"), cursor: local }, "other folder"],
      [{ location: "s3://subs/out/", cursor: remote }, "other API folder"],
      [{ location: dir, cursor: "not a cursor" }, "spaces"],
      [{ location: dir, cursor: local.slice(0, local.length >> 1) }, "half"],
      [{ location: dir, cursor: "" }, "empty"],
      [{ location: dir, cursor: forge({ v: 2, m: "local", b: "x", a: "a1" }) }, "version"],
      [{ location: dir, cursor: "x".repeat(9000) }, "too long"],
    ];
    for (const [args, why] of cases) expect((await callTool(h, "list_files", args)).structuredContent.error?.code, why).toBe("list-cursor-invalid");
    expect(storageCalls()).toEqual([]);
    const page2 = await callTool(h, "list_files", { location: dir, cursor: local });
    expect(page2.structuredContent.items[0].name).toBe("a200.srt");
  });
});

describe("preview_text {location}", () => {
  it("local long SRT: whole-cue pages join to the file, text sent once, cursor bound to the file, changed file detected", async () => {
    const text = longSrt(); const file = path.join(dir, "long.srt"), other = path.join(dir, "other.srt");
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])); fs.writeFileSync(other, text);
    h = await mk(true); apiStorage({ list: false });
    const pages: any[] = []; let cursor: string | undefined;
    do {
      const r = await callTool(h, "preview_text", { location: file, ...(cursor ? { cursor } : {}) });
      expect(r.isError, JSON.stringify(r.structuredContent?.error)).toBeFalsy();
      expect(r.content).toHaveLength(1); expect(r.content[0].text).not.toContain(probe(1));
      expect(occurrences(JSON.stringify(r), probe(1234) + "\\n")).toBe(occurrences(r.structuredContent.text, probe(1234) + "\n"));
      pages.push(r.structuredContent); cursor = r.structuredContent.next;
    } while (cursor);
    expect(pages.map((p) => p.text).join("")).toBe(text);
    expect(pages[0]).toMatchObject({ source: "local", location: file, fileName: "long.srt", mediaType: "application/x-subrip", unit: "cue", fromCue: 1 });
    expect(pages[0].jobId).toBeUndefined();
    const next = (await callTool(h, "preview_text", { location: file })).structuredContent.next;
    expect((await callTool(h, "preview_text", { location: other, cursor: next })).structuredContent.error.code).toBe("preview-cursor-invalid");
    fs.appendFileSync(file, "\n");
    expect((await callTool(h, "preview_text", { location: file, cursor: next })).structuredContent.error.code).toBe("preview-source-changed");
    expect(storageCalls()).toEqual([]);
  });

  it("local: outside, traversal and outside symlinks are refused; UTF-16 is decoded; both location and jobId is invalid", async () => {
    fs.symlinkSync(path.join(outside, "secret.srt"), path.join(dir, "escape.srt"));
    fs.writeFileSync(path.join(dir, "u16.srt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SRT, "utf16le")]));
    h = await mk(true); apiStorage({ list: false });
    for (const location of [path.join(outside, "secret.srt"), path.join(dir, "..", path.basename(outside), "secret.srt"), path.join(dir, "escape.srt")]) {
      const r = await callTool(h, "preview_text", { location });
      expect(r.structuredContent.error.code).toBe("path-not-allowed"); expect(JSON.stringify(r)).not.toContain("SECRET");
    }
    const u16 = await callTool(h, "preview_text", { location: path.join(dir, "u16.srt") });
    expect(u16.structuredContent).toMatchObject({ text: SRT, unit: "cue" }); expect(u16.structuredContent.convertedFrom).toBeUndefined();
    const both = await callTool(h, "preview_text", { location: path.join(dir, "u16.srt"), jobId: "j1", which: "input" });
    expect(both.structuredContent.error.code).toBe("invalid-arguments");
    const none = await callTool(h, "preview_text", {});
    expect(none.structuredContent.error.code).toBe("invalid-arguments");
    const noWhich = await callTool(h, "preview_text", { jobId: "j1" });
    expect(occurrences(noWhich.content[0].text, "`which` is required")).toBe(1);
  });

  it("API location: read through /v1/storage/file with its own request id; job cursors don't fit; binary converts to SRT", async () => {
    const stl = Buffer.from("850STL25.01\0binary-bytes");
    apiStorage({ list: true, files: { "s3://subs/in/long.srt": Buffer.from(longSrt(300)), "s3://subs/in/show.stl": stl } });
    let converted: any;
    mswServer.use(http.post(`${API}/v1/convert/json`, async ({ request }) => { converted = await request.json(); return HttpResponse.json(convertOk([{ fileName: "show.srt", content: SRT, formatId: "subrip" }], { detected: { id: "ebustl", kind: "binary" } })); }));
    h = await mk(true);
    const first = await callTool(h, "preview_text", { location: "s3://subs/in/long.srt", maxBytes: 4096 });
    expect(first.structuredContent).toMatchObject({ source: "remote", location: "s3://subs/in/long.srt", fileName: "long.srt", truncated: true });
    const fileReq = recorded.find((r) => r.path === "/v1/storage/file")!;
    expect(new URL(fileReq.url).searchParams.get("location")).toBe("s3://subs/in/long.srt");
    expect(fileReq.headers["x-request-id"]).toMatch(/\.f$/);
    const second = await callTool(h, "preview_text", { location: "s3://subs/in/long.srt", cursor: first.structuredContent.next });
    expect(second.structuredContent.fromCue).toBe(first.structuredContent.toCue + 1);
    expect((await callTool(h, "preview_text", { location: "s3://subs/in/show.stl", cursor: first.structuredContent.next })).structuredContent.error.code).toBe("preview-cursor-invalid");
    const bin = await callTool(h, "preview_text", { location: "s3://subs/in/show.stl" });
    expect(bin.structuredContent).toMatchObject({ source: "remote", convertedFrom: "ebustl", convertedTo: "srt", text: SRT });
    expect(Buffer.from(converted.content, "base64").equals(stl)).toBe(true); expect(converted.output).toBeUndefined();
    const missing = await callTool(h, "preview_text", { location: "s3://subs/in/missing.srt" });
    expect(missing.structuredContent.error.code).toBe("storage-not-found");
  });

  it("presigned or credentialed API locations are redacted in results and logs", async () => {
    apiStorage({ list: true });
    h = await mk(true, { logPaths: true });
    const r = await callTool(h, "preview_text", { location: "https://user:pw@mam.example.com/a.srt?X-Amz-Signature=FAKESIG" });
    expect(r.isError).toBe(true);
    for (const secret of ["FAKESIG", "user:pw"]) { expect(JSON.stringify(r)).not.toContain(secret); expect(h.logs.join("\n")).not.toContain(secret); }
  });
});

describe("schemas and regressions with listing on", () => {
  it("list_files, list_allowed_folders (remote) and preview_text {location} validate against their output schemas", async () => {
    apiStorage({ list: true, files: { "s3://subs/in/a.srt": Buffer.from(SRT) } });
    fs.writeFileSync(path.join(dir, "a.srt"), SRT);
    h = await mk(true);
    const tools = (await h.client.listTools()).tools;
    const ajv = new Ajv({ strict: false, allErrors: true });
    for (const [name, args] of [["list_files", { location: dir }], ["list_files", { location: "s3://subs/in/" }], ["list_files", { location: dir, cursor: "bad" }],
      ["list_allowed_folders", {}], ["preview_text", { location: path.join(dir, "a.srt") }], ["preview_text", { location: "s3://subs/in/a.srt" }], ["preview_text", { location: "s3://subs/in/none.srt" }]] as const) {
      const validate = ajv.compile(tools.find((t) => t.name === name)!.outputSchema!);
      const r = await callTool(h, name, args);
      expect(validate(r.structuredContent), `${name} ${JSON.stringify(args)}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });

  it("inline convert still attaches the whole file byte-exact", async () => {
    const file = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(longSrt(200))]);
    mswServer.use(http.post(`${API}/v1/convert/json`, () => HttpResponse.json({ id: "j1", ...convertOk([{ fileName: "a.srt", content: file.toString("base64"), contentEncoding: "base64", formatId: "subrip" } as any]) })));
    apiStorage({ list: true });
    h = await mk(true);
    const r = await callTool(h, "convert_subtitle", { content: SRT, target: "srt" });
    expect(Buffer.from(r.content[1].resource.text, "utf8").equals(file)).toBe(true);
  });
});
