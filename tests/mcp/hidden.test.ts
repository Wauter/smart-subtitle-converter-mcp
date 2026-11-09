/**
 * Hidden-path policy (QA p9 issue 1): dotfiles, anything inside a dot-named folder, hidden allowed folders and symlinks to
 * hidden targets are never read or listed by any local tool (preview_text, list_files, convert_subtitle/detect_format path,
 * validate_profile path), with browsing on or off. Ordinary dotted names still work. Also raw NUL paths (p9 issue 2) and
 * the missing-`which` error shape (p9 minor).
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { API, LIMITS, SRT, baseHandlers, callTool, convertOk, harness, mswServer, problem, recorded, tmpDir, type Harness } from "../helpers/harness.js";
import { isHiddenPath, realpathRoots } from "../../src/fs/guard.js";
import { apiInfo } from "../../src/api/info.js";

const SENTINEL = "HIDDEN_SENTINEL_P9";
const HIDDEN = `1\n00:00:01,000 --> 00:00:02,000\n${SENTINEL}\n`;
let h: Harness | undefined;
let dir: string, hiddenRoot: string, parent: string;
const limits = (list: boolean) => ({ ...LIMITS, storage: { inputSchemes: ["file", "s3"], outputSchemes: ["file", "s3"], list, listSchemes: list ? ["file", "s3"] : [] } });
const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

beforeAll(() => mswServer.listen({ onUnhandledFrame: "error" })); afterAll(() => mswServer.close());
beforeEach(() => {
  recorded.length = 0; apiInfo.probedAt = Date.now(); mswServer.use(...baseHandlers());
  dir = tmpDir("mcp-hidden-");
  parent = tmpDir("mcp-hparent-"); hiddenRoot = path.join(parent, ".hidden-root"); fs.mkdirSync(hiddenRoot);
  w(path.join(dir, "plain.srt"), SRT); w(path.join(dir, "show.en.v2.srt"), SRT); w(path.join(dir, "v1.2", "ep.srt"), SRT);
  w(path.join(dir, ".env"), HIDDEN); w(path.join(dir, ".hidden.srt"), HIDDEN);
  w(path.join(dir, ".hiddendir", "in-hidden.srt"), HIDDEN); w(path.join(dir, ".hiddendir", "deeper", "x.srt"), HIDDEN);
  w(path.join(dir, "sub", ".git", "c.srt"), HIDDEN); w(path.join(dir, ".nested-root", "r.srt"), HIDDEN);
  w(path.join(dir, "profiles", ".p.json"), "{}");
  w(path.join(hiddenRoot, "r.srt"), HIDDEN);
  fs.symlinkSync(path.join(dir, ".hidden.srt"), path.join(dir, "alias.srt")); // in-root symlink to a hidden target
  fs.symlinkSync(path.join(dir, ".hiddendir"), path.join(dir, "aliasdir"));
  fs.symlinkSync(path.join(dir, "plain.srt"), path.join(dir, "visible-link.srt"));
});
afterEach(async () => { await h?.close(); h = undefined; mswServer.resetHandlers(); for (const d of [dir, parent]) fs.rmSync(d, { recursive: true, force: true }); });

// The nested hidden root and the hidden standalone root are allowed folders themselves: neither may become a way in.
const mk = async (listEnabled: boolean) => harness({ listEnabled }, { roots: await realpathRoots([dir, path.join(dir, ".nested-root"), hiddenRoot], []) });
const hiddenFiles = () => [
  path.join(dir, ".env"), path.join(dir, ".hidden.srt"), path.join(dir, ".hiddendir", "in-hidden.srt"), path.join(dir, ".hiddendir", "deeper", "x.srt"),
  path.join(dir, "sub", ".git", "c.srt"), path.join(dir, ".nested-root", "r.srt"), path.join(hiddenRoot, "r.srt"), path.join(dir, ".missing.srt"),
  path.join(dir, "alias.srt"), path.join(dir, "aliasdir", "in-hidden.srt"), path.join(dir, "sub", "..", ".env"),
];
const refused = (r: any, what: string) => {
  expect(r.structuredContent?.error?.code, `${what}: ${JSON.stringify(r.structuredContent)}`).toBe("path-not-allowed");
  expect(JSON.stringify(r)).not.toContain(SENTINEL);
};

describe("hidden files and folders, local", () => {
  it("preview_text {location} refuses every hidden variant, including symlink aliases, and reads ordinary dotted names", async () => {
    h = await mk(true);
    mswServer.use(http.get(`${API}/v1/limits`, () => HttpResponse.json(limits(false))));
    for (const location of hiddenFiles()) refused(await callTool(h, "preview_text", { location }), location);
    const hint = (await callTool(h, "preview_text", { location: path.join(dir, ".env") })).structuredContent.error;
    expect(hint.detail).toContain("Hidden files and folders");
    expect(hint.hint).not.toContain(".hidden-root"); expect(hint.hint).not.toContain(".nested-root"); // hidden allowed folders aren't named
    for (const location of [path.join(dir, "plain.srt"), path.join(dir, "show.en.v2.srt"), path.join(dir, "v1.2", "ep.srt"), path.join(dir, "visible-link.srt")]) {
      const r = await callTool(h, "preview_text", { location });
      expect(r.isError, JSON.stringify(r.structuredContent?.error)).toBeFalsy(); expect(r.structuredContent.text).toBe(SRT);
    }
    expect(recorded.filter((r) => r.path.startsWith("/v1/storage/"))).toEqual([]);
  });

  it("list_files skips hidden entries and hidden symlink targets, and refuses hidden folders directly, through a prefix or a symlink", async () => {
    h = await mk(true);
    const names = (await callTool(h, "list_files", { location: dir })).structuredContent.items.map((i: any) => i.name);
    expect(names).toEqual(["plain.srt", "profiles/", "show.en.v2.srt", "sub/", "v1.2/", "visible-link.srt"]);
    expect((await callTool(h, "list_files", { location: path.join(dir, "sub") })).structuredContent.items).toEqual([]);
    const cases: Record<string, unknown>[] = [
      { location: path.join(dir, ".hiddendir") }, { location: path.join(dir, ".hiddendir", "deeper") }, { location: path.join(dir, "sub", ".git") },
      { location: dir, prefix: ".hiddendir/" }, { location: dir, prefix: "sub/.git/" }, { location: path.join(dir, "aliasdir") }, { location: dir, prefix: "aliasdir/" },
      { location: path.join(dir, ".nested-root") }, { location: hiddenRoot }, { location: path.join(dir, ".nope") },
    ];
    for (const args of cases) refused(await callTool(h, "list_files", args), JSON.stringify(args));
    expect((await callTool(h, "list_files", { location: dir, prefix: ".h" })).structuredContent.items).toEqual([]);
    // Hidden allowed folders are not named anywhere: list_allowed_folders, tool descriptions, path-not-allowed hints.
    const folders = await callTool(h, "list_allowed_folders", {});
    expect(folders.structuredContent.folders.map((f: any) => f.path)).toEqual([fs.realpathSync(dir)]);
    expect(folders.structuredContent.hiddenFolders).toBe(2);
    const tools = JSON.stringify((await h.client.listTools()).tools);
    for (const text of [JSON.stringify(folders), tools, JSON.stringify(await callTool(h, "list_files", { location: "/etc" }))]) {
      expect(text).not.toContain(".hidden-root"); expect(text).not.toContain(".nested-root");
    }
  });

  it("convert_subtitle, detect_format and validate_profile paths can't read hidden files either, with browsing off", async () => {
    h = await mk(false);
    for (const p of hiddenFiles()) {
      refused(await callTool(h, "convert_subtitle", { path: p, target: "vtt" }), `convert ${p}`);
      refused(await callTool(h, "detect_format", { path: p }), `detect ${p}`);
    }
    refused(await callTool(h, "validate_profile", { path: path.join(dir, "profiles", ".p.json") }), "validate_profile");
    refused(await callTool(h, "convert_subtitle", { content: SRT, target: "vtt", profilePath: path.join(dir, "profiles", ".p.json") }), "profilePath");
    expect(recorded.filter((r) => r.path.startsWith("/v1/convert") || r.path.startsWith("/v1/detect"))).toEqual([]);
    // Control: an ordinary dotted file converts. Writes keep their rules (a dot-named output is still written).
    mswServer.use(http.post(`${API}/v1/convert/json`, () => HttpResponse.json(convertOk([{ fileName: "show.en.v2.vtt", content: "WEBVTT\n" }]))));
    const ok = await callTool(h, "convert_subtitle", { path: path.join(dir, "show.en.v2.srt"), target: "vtt", outputPath: path.join(dir, ".written.vtt") });
    expect(ok.isError, JSON.stringify(ok.structuredContent?.error)).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, ".written.vtt"), "utf8")).toBe("WEBVTT\n");
    refused(await callTool(h, "detect_format", { path: path.join(dir, ".written.vtt") }), "written hidden output");
  });

  it("raw NUL paths are refused without touching the filesystem; API rejections of encoded NULs pass through as 422", async () => {
    mswServer.use(http.get(`${API}/v1/limits`, () => HttpResponse.json(limits(true))),
      http.get(`${API}/v1/storage/file`, () => problem(422, "storage-location-rejected", { detail: "The decoded location contains control characters (for example an encoded NUL, %00); file names can't contain them." })),
      http.get(`${API}/v1/storage/list`, () => problem(422, "storage-location-rejected")));
    h = await mk(true);
    for (const location of [path.join(dir, "plain.srt") + "\0.txt", path.join(dir, "plain.srt\0")]) {
      expect((await callTool(h, "preview_text", { location })).structuredContent.error.code).toBe("path-not-allowed");
      expect((await callTool(h, "list_files", { location: path.dirname(location) + "/\0" })).structuredContent.error.code).toBe("path-not-allowed");
    }
    expect((await callTool(h, "list_files", { location: dir, prefix: "a\0b" })).structuredContent.error.code).toBe("invalid-arguments");
    const remote = await callTool(h, "preview_text", { location: "file:///data/subs/plain.srt%00.txt" });
    expect(remote.structuredContent.error).toMatchObject({ source: "api", status: 422, code: "storage-location-rejected" });
    expect((await callTool(h, "list_files", { location: "file:///data/subs/%00/" })).structuredContent.error).toMatchObject({ status: 422, code: "storage-location-rejected" });
  });

  it("isHiddenPath is per component, on both path flavours", () => {
    expect(isHiddenPath("/a/.env")).toBe(true); expect(isHiddenPath("/a/.git/x")).toBe(true); expect(isHiddenPath("/home/u/.subs/a.srt")).toBe(true);
    expect(isHiddenPath("/a/show.en.srt")).toBe(false); expect(isHiddenPath("/a/v1.2/a..b.")).toBe(false); expect(isHiddenPath("/")).toBe(false);
    expect(isHiddenPath("C:\\Users\\me\\.cache\\a.srt", "win32")).toBe(true); expect(isHiddenPath("C:\\Users\\me\\a.b.srt", "win32")).toBe(false);
  });
});

describe("preview_text missing `which` keeps the pointer and hint (p9 minor)", () => {
  it.each([true, false])("browsing %s: same shape as other argument errors", async (listEnabled) => {
    h = await mk(listEnabled);
    const r = await callTool(h, "preview_text", { jobId: "j1" });
    expect(r.structuredContent.error).toMatchObject({
      source: "mcp", code: "invalid-arguments",
      detail: 'Invalid arguments: /which: `which` is required (valid values: "input" | "output").',
      hint: "Fix the arguments as described and call again.",
      errors: [{ pointer: "/which", message: '`which` is required (valid values: "input" | "output").' }],
    });
    expect(r.content[0].text.split("`which` is required")).toHaveLength(2);
    if (listEnabled) {
      expect((await callTool(h, "preview_text", {})).structuredContent.error.errors).toEqual([expect.objectContaining({ pointer: "/location" })]);
      expect((await callTool(h, "preview_text", { location: path.join(dir, "plain.srt"), jobId: "j1" })).structuredContent.error.errors).toEqual([expect.objectContaining({ pointer: "/jobId" })]);
    }
  });
});
