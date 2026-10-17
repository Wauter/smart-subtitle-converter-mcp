/**
 * Contract suite against a real converter API (§14), the version this MCP targets (D-36/D-37). Gated on CONTRACT_API_URL.
 *   CONTRACT_API_URL      e.g. http://127.0.0.1:4041 (the API's Compose host port)
 *   CONTRACT_API_KEY      key configured on the API (second run)
 *   CONTRACT_SMALL_LIMITS "1" when the API runs with MAX_UPLOAD_BYTES=1048576 ZIP_MAX_ENTRIES=3
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { callTool, harness, tmpDir, SRT, type Harness } from "../helpers/harness.js";
import { realpathRoots } from "../../src/fs/guard.js";
import { probeApi } from "../../src/probe.js";

const URL_ = process.env.CONTRACT_API_URL?.replace(/\/+$/, "");
const KEY = process.env.CONTRACT_API_KEY || undefined;
const SMALL = process.env.CONTRACT_SMALL_LIMITS === "1";

const srt = (n: number, text = "Hello") =>
  Array.from({ length: n }, (_, i) => `${i + 1}\n00:00:${String(i % 60).padStart(2, "0")},000 --> 00:00:${String(i % 60).padStart(2, "0")},900\n${text} ${i + 1}\n`).join("\n");

describe.skipIf(!URL_)("contract: real API", () => {
  let dir: string, h: Harness;
  const mk = async (cfg = {}) => harness({ apiUrl: URL_!, apiKey: KEY, ...cfg }, { roots: await realpathRoots([dir], []) });
  const put = (rel: string, content: string | Buffer = SRT) => {
    const p = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };
  const direct = async (body: unknown) => {
    const r = await fetch(`${URL_}/v1/convert/json`, { method: "POST", headers: { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) }, body: JSON.stringify(body) });
    return (await r.json()) as any;
  };
  beforeAll(async () => {
    dir = fs.realpathSync(tmpDir("contract-"));
    h = await mk();
    await probeApi(h.deps.cfg, h.deps.log);
  });
  afterAll(async () => {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("list_formats / list_presets / get_profile", async () => {
      const f = await callTool(h, "list_formats", { includeBinary: true, limit: 500 });
      expect(f.isError).toBeFalsy();
      const ids = f.structuredContent.formats.map((x: any) => x.id);
      expect(ids).toEqual(expect.arrayContaining(["subrip", "webvtt", "ebustl"]));
      const p = await callTool(h, "list_presets", {});
      const names = p.structuredContent.presets.map((x: any) => x.name);
      expect(names).toContain("srt-to-vtt");
      const g = await callTool(h, "get_profile", { name: "srt-to-vtt" });
      expect(g.isError).toBeFalsy();
      expect(g.structuredContent.resolved.target.format).toBeTruthy();
    });
    it("validate_profile valid and invalid; detect on SRT", async () => {
      const ok = await callTool(h, "validate_profile", { profile: { target: { format: "webvtt" } } });
      expect(ok.structuredContent.valid).toBe(true);
      const bad = await callTool(h, "validate_profile", { profile: { target: { format: "no-such-format" } } });
      expect(bad.structuredContent.valid).toBe(false);
      expect(bad.structuredContent.errors.length).toBeGreaterThan(0);
      const d = await callTool(h, "detect_format", { content: SRT, fileName: "a.srt" });
      expect(d.structuredContent.id).toBe("subrip");
    });
    it("version check: /healthz is read; 89ce197 still reports 1.0.0, so the mismatch warning is expected there", async () => {
      const { apiInfo } = await import("../../src/api/info.js");
      expect(apiInfo.version).toMatch(/^\d+\.\d+\.\d+/);
      const f = await callTool(h, "list_formats", {});
      if (apiInfo.versionMismatch) expect(f.content[0].text).toMatch(/mcp-api-version-mismatch/);
      else expect(f.content[0].text).not.toMatch(/mcp-api-version-mismatch/);
    });
    it("limits resource available (target API)", async () => {
      const r: any = await h.client.readResource({ uri: "subtitleedit://limits" });
      const l = JSON.parse(r.contents[0].text);
      expect(l.zip.maxEntries).toBe(SMALL ? 3 : 100);
    });
  });

  describe("single file", () => {
    it("SRT→VTT inline and to disk byte-exact vs direct API output", async () => {
      const inline = await callTool(h, "convert_subtitle", { content: SRT, fileName: "a.srt", target: "webvtt" });
      expect(inline.isError).toBeFalsy();
      expect(inline.content.find((c: any) => c.type === "text" && c.text.startsWith("WEBVTT"))).toBeTruthy();
      const src = put("single/a.srt");
      const out = path.join(dir, "single", "a.vtt");
      const disk = await callTool(h, "convert_subtitle", { path: src, target: "webvtt", outputPath: out });
      expect(disk.structuredContent.outputs[0]).toMatchObject({ writtenTo: out, action: "written" });
      const ref = await direct({ content: Buffer.from(SRT).toString("base64"), contentEncoding: "base64", fileName: "a.srt", target: "webvtt", responseEncoding: "base64" });
      expect(fs.readFileSync(out).equals(Buffer.from(ref.outputs[0].content, "base64"))).toBe(true);
      expect(fs.readdirSync(path.dirname(out)).filter((n) => n.endsWith(".partial"))).toEqual([]);
    });
    it("target.additional: multiple-outputs with outputPath, success with outputDir", async () => {
      const src = put("multi/a.srt");
      const profile = { target: { format: "webvtt", additional: ["ttml"] } };
      const e = await callTool(h, "convert_subtitle", { path: src, profile, outputPath: path.join(dir, "multi", "x.vtt") });
      expect(e.structuredContent.error.code).toBe("multiple-outputs");
      const ok = await callTool(h, "convert_subtitle", { path: src, profile, outputDir: path.join(dir, "multi", "out") });
      expect(ok.isError).toBeFalsy();
      expect(ok.structuredContent.outputs).toHaveLength(2);
    });
    it("write flow: existing outputPath under error → no request; archive and replace", async () => {
      const src = put("wf/a.srt");
      const out = put("wf/a.vtt", "old");
      const e = await callTool(h, "convert_subtitle", { path: src, target: "webvtt", outputPath: out });
      expect(e.structuredContent.error.code).toBe("output-exists");
      expect(e.structuredContent.attempts ?? 0).toBe(0);
      expect(fs.readFileSync(out, "utf8")).toBe("old");
      const a = await callTool(h, "convert_subtitle", { path: src, target: "webvtt", outputPath: out, ifExists: "archive" });
      expect(a.structuredContent.outputs[0].action).toBe("archived");
      expect(fs.readFileSync(a.structuredContent.outputs[0].archivedTo, "utf8")).toBe("old");
      const hd = await mk({ allowDestructive: true });
      const r = await callTool(hd, "convert_subtitle", { path: src, target: "webvtt", outputPath: out, ifExists: "replace" });
      await hd.close();
      expect(r.structuredContent.outputs[0].action).toBe("replaced");
      expect(fs.readFileSync(out, "utf8")).toMatch(/^\uFEFF?WEBVTT/);
    });
    it.skipIf(SMALL)("8.5 MB SRT by path goes through JSON", async () => {
      let big = "";
      let i = 0;
      while (big.length < 8.5 * 1024 * 1024) big += `${++i}\n00:00:01,000 --> 00:00:02,000\n${"x".repeat(200)}\n\n`;
      const src = put("big/big.srt", big);
      const r = await callTool(h, "convert_subtitle", { path: src, target: "webvtt", outputDir: path.join(dir, "big", "out") });
      expect(r.isError).toBeFalsy();
    }, 120_000);
    it.skipIf(!SMALL)("too-large input is refused before upload (limits pre-check)", async () => {
      const src = put("big/big.srt", "x".repeat(1_100_000));
      const r = await callTool(h, "convert_subtitle", { path: src, target: "webvtt" });
      expect(r.structuredContent.error).toMatchObject({ code: "precheck-too-large", limit: { name: "json.maxDecodedContentBytes", value: 1048576 } });
      expect(r.structuredContent.attempts ?? 0).toBe(0);
    });
  });

  describe("errors", () => {
    it("empty-input / preset-not-found / invalid-profile; requestId echoes the MCP id", async () => {
      const e = await callTool(h, "convert_subtitle", { content: "", fileName: "a.srt", target: "webvtt" });
      expect(e.structuredContent.error.code).toBe("empty-input");
      expect(e.structuredContent.error.requestId).toMatch(/^mcp-[0-9A-Z]{26}/);
      const p = await callTool(h, "convert_subtitle", { content: SRT, fileName: "a.srt", preset: "no-such-preset" });
      expect(p.structuredContent.error.code).toBe("preset-not-found");
      const i = await callTool(h, "convert_subtitle", { content: SRT, fileName: "a.srt", profile: { target: { format: "nope" } } });
      expect(i.structuredContent.error.code).toBe("invalid-profile");
    });
    it.skipIf(!KEY)("401 with a wrong key → unauthorized with the SUBTITLE_API_KEY hint", async () => {
      const bad = await mk({ apiKey: "wrong-key" });
      const r = await callTool(bad, "list_formats", {});
      expect(r.structuredContent.error).toMatchObject({ source: "api", status: 401, code: "unauthorized" });
      expect(r.structuredContent.error.hint).toMatch(/SUBTITLE_API_KEY/);
      await bad.close();
    });
  });

  describe("batch (D-44: all or nothing)", () => {
    const stagingLeft = () => {
      const st = path.join(dir, ".subtitle-mcp-staging");
      return fs.existsSync(st) ? fs.readdirSync(st) : [];
    };
    it("mixed folder, local exclusions, aliases, subfolders kept; forced multi-chunk; atomic commit", async () => {
      const b = path.join(dir, "batch");
      put("batch/a.srt", srt(3));
      put("batch/s1/b.vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n");
      put("batch/a..b.srt", srt(2));
      put("batch/manifest.json", srt(1)); // aliased (the API would drop a top-level manifest.json)
      put("batch/n.zip", "PK\x03\x04");
      put("batch/._x.srt", "junk");
      put("batch/__MACOSX/c.srt", "junk");
      put("batch/old.vtt.20261017-093012.bak", "bak");
      // Force several chunks via the response estimate (batchMaxEntries is only a fallback when /v1/limits is unreadable).
      const hh = await mk({ batchMaxResponseBytes: 65_536 + 400 });
      const out = path.join(dir, "batch-out");
      const r = await callTool(hh, "convert_batch", { inputDir: b, pattern: "**/*", outputDir: out, target: "webvtt", writeManifest: true });
      await hh.close();
      expect(r.isError).toBeFalsy();
      const by = Object.fromEntries(r.structuredContent.entries.map((e: any) => [path.relative(b, e.source), e]));
      expect(by["s1/b.vtt"].outputs).toEqual([path.join(out, "s1", "b.vtt")]);
      expect(by["a..b.srt"].outputs).toEqual([path.join(out, "a..b.vtt")]);
      expect(by["manifest.json"].outputs).toEqual([path.join(out, "manifest.vtt")]);
      expect(by["a.srt"].detected.id).toBe("subrip");
      expect(r.structuredContent.excluded.map((x: any) => x.reason).sort()).toEqual(["macos-metadata", "macos-metadata", "nested-zip"]);
      expect(r.structuredContent.totals.chunks).toBeGreaterThan(1);
      expect(fs.readdirSync(out).sort()).toEqual(["a..b.vtt", "a.vtt", "manifest.vtt", "s1", "subtitle-mcp-manifest.json"]);
      expect(stagingLeft()).toEqual([]);
    });
    it("chunking by estimated response size", async () => {
      for (let i = 0; i < 3; i++) put(`rs/f${i}.srt`, srt(400));
      const hh = await mk({ batchMaxResponseBytes: 120_000 });
      const r = await callTool(hh, "convert_batch", { inputDir: path.join(dir, "rs"), outputDir: path.join(dir, "rs-out"), target: "webvtt" });
      await hh.close();
      expect(r.structuredContent.totals).toMatchObject({ converted: 3 });
      expect(r.structuredContent.totals.chunks).toBeGreaterThanOrEqual(2);
    });
    it("a bad second file (real failFast problem from the API): batch-failed, later chunks not sent, nothing written", async () => {
      put("ff/1.srt", srt(2));
      put("ff/2.srt", "garbage that is not a subtitle\n");
      put("ff/3.srt", srt(2));
      put("ff/4.srt", srt(2));
      // Two files per chunk: the response estimate is Σsize × 2 + 64 KiB (§5.7.3).
      const sz = (n: string) => fs.statSync(path.join(dir, "ff", n)).size;
      const hh = await mk({ batchMaxResponseBytes: 65_536 + 2 * (sz("1.srt") + sz("2.srt")) });
      const out = path.join(dir, "ff", "new", "ff-out");
      const r = await callTool(hh, "convert_batch", { inputDir: path.join(dir, "ff"), outputDir: out, target: "webvtt" });
      await hh.close();
      expect(r.structuredContent.error.code).toBe("batch-failed");
      expect(r.structuredContent.failures).toEqual([expect.objectContaining({ source: path.join(dir, "ff", "2.srt"), code: "format-not-detected", requestId: expect.any(String) })]);
      expect(r.structuredContent).toMatchObject({ converted: 1, notAttempted: 2 });
      expect(r.structuredContent.requestIds).toHaveLength(1);
      expect(fs.existsSync(path.join(dir, "ff", "new"))).toBe(false);
      expect(stagingLeft()).toEqual([]);
    });
    it("an existing outputDir → output-dir-exists, nothing sent", async () => {
      put("ex/a.srt", srt(2));
      put("ex-out/a.vtt", "old");
      const r = await callTool(h, "convert_batch", { inputDir: path.join(dir, "ex"), outputDir: path.join(dir, "ex-out"), target: "webvtt" });
      expect(r.structuredContent.error.code).toBe("output-dir-exists");
      expect(fs.readdirSync(path.join(dir, "ex-out"))).toEqual(["a.vtt"]);
    });
    it("D-29 local check and preserveStructure", async () => {
      put("amb/s1/ep1.srt", srt(1));
      put("amb/s1/EP1.vtt", "WEBVTT\n");
      let r = await callTool(h, "convert_batch", { inputDir: path.join(dir, "amb"), pattern: "**/*", outputDir: path.join(dir, "amb-out"), target: "webvtt" });
      expect(r.structuredContent.error.code).toBe("ambiguous-batch-names");
      put("amb2/s1/ep1.srt", srt(1));
      put("amb2/s2/ep1.srt", srt(1));
      r = await callTool(h, "convert_batch", { inputDir: path.join(dir, "amb2"), pattern: "**/*", outputDir: path.join(dir, "amb2-out"), target: "webvtt" });
      expect(r.structuredContent.totals.converted).toBe(2);
      r = await callTool(h, "convert_batch", { inputDir: path.join(dir, "amb2"), pattern: "**/*", outputDir: path.join(dir, "amb2-flat"), target: "webvtt", preserveStructure: false });
      expect(r.structuredContent.error.code).toBe("ambiguous-batch-names");
    });
    it("API 422 output clash (target.additional to the same format) maps outputs to local paths; nothing written", async () => {
      put("clash/a.srt", srt(2));
      const out = path.join(dir, "clash-out");
      const r = await callTool(h, "convert_batch", { inputDir: path.join(dir, "clash"), outputDir: out, profile: { target: { format: "webvtt", additional: ["webvtt"] } } });
      if (r.isError) {
        expect(["ambiguous-batch-names", "invalid-profile"]).toContain(r.structuredContent.error.code);
        for (const o of r.structuredContent.error.outputs ?? []) expect(path.isAbsolute(o)).toBe(true);
        expect(fs.existsSync(out)).toBe(false);
      } else {
        expect(fs.readdirSync(out).filter((n) => /_2\./.test(n))).toEqual([]);
      }
      expect(stagingLeft()).toEqual([]);
    });
  });

  describe("1.2.0: verification, actionable warnings, source diagnostics, ambiguous-format", () => {
    const GREEK = "1\n00:00:01,000 --> 00:00:02,500\nΚαλημέρα κόσμε\n\n2\n00:00:03,000 --> 00:00:04,000\nΕίναι μια δοκιμή\n\n3\n00:00:05,000 --> 00:00:06,000\nΤέλος της δοκιμής\n";
    const ZERO = "1\n00:00:00,000 --> 00:00:00,000\nmeta\n\n2\n00:00:01,000 --> 00:00:02,000\nHello\n\n3\n00:00:03,000 --> 00:00:04,000\nWorld\n";
    it("SRT→PAC Greek: lossy verification with replaced chars by cue/code point, actionable hint; codePage greek → quantised", async () => {
      const src = put("v12/greek.srt", GREEK);
      const r = await callTool(h, "convert_subtitle", { path: src, target: "pac", outputDir: path.join(dir, "v12", "pac-latin") });
      expect(r.isError).toBeFalsy();
      const v = r.structuredContent.outputs[0].verification;
      expect(v.verdict).toBe("lossy");
      expect(v.cuesWritten).toBe(3);
      expect(v.cuesReadBack).toBe(3);
      expect(v.replacedChars.cues).toEqual([1, 2, 3]);
      expect(v.replacedChars.codePoints[0].codePoint).toMatch(/^U\+03[9A-F][0-9A-F]$/);
      expect(JSON.stringify(v)).not.toMatch(/[Α-ω]/); // positions and code points only, never cue text
      const w = r.structuredContent.warnings.find((x: any) => x.code === "characters-replaced");
      expect(w.hint).toMatch(/pac\.codePage.*greek/);
      expect(w.details.cues).toEqual([1, 2, 3]);
      expect(r.content[0].text).toMatch(/Verification of greek\.pac: lossy: 3\/3 cues read back; \d+ char\(s\) replaced in cue\(s\) 1, 2, 3/);
      const g = await callTool(h, "convert_subtitle", { path: src, profile: { target: { format: "pac" }, formatOptions: { pac: { codePage: "greek" } } }, outputDir: path.join(dir, "v12", "pac-greek") });
      expect(g.structuredContent.outputs[0].verification.verdict).toMatch(/^(quantised|lossless)$/);
    });
    it("zero-length cue → EBU STL: zero-length-cue warning and verification.zeroLengthCues", async () => {
      const src = put("v12/zero.srt", ZERO);
      const r = await callTool(h, "convert_subtitle", { path: src, target: "ebustl", outputDir: path.join(dir, "v12", "ebu") });
      expect(r.isError).toBeFalsy();
      const v = r.structuredContent.outputs[0].verification;
      expect(v.verdict).toBe("lossy");
      expect(v.zeroLengthCues).toEqual({ total: 1, cues: [1] });
      const codes = r.structuredContent.warnings.map((x: any) => x.code);
      expect(codes).toEqual(expect.arrayContaining(["zero-length-cue", "lossy-format"]));
      expect(r.structuredContent.warnings.find((x: any) => x.code === "lossy-format" && /99:59:59,999/.test(x.message)).hint).toMatch(/ApplyDurationLimits/);
    });
    it("detect_format: bom, lineEndings and source warnings", async () => {
      const d = await callTool(h, "detect_format", { content: "\uFEFF" + ZERO.replace(/\n/g, "\r\n"), fileName: "z.srt" });
      expect(d.structuredContent.bom).toBe(true);
      expect(d.structuredContent.lineEndings).toBe("crlf");
      expect(d.structuredContent.warnings.map((x: any) => x.code)).toContain("zero-length-cue");
    });
    it("PAC/FPC ambiguity: no deciding name → ambiguous-format with candidates; .fpc name or source.format decides", async () => {
      const bytes = fs.readFileSync(new URL("./fixtures/sample.fpc.bin", import.meta.url));
      const bin = put("v12/amb.bin", bytes);
      const r = await callTool(h, "convert_subtitle", { path: bin, target: "subrip" });
      expect(r.isError).toBe(true);
      expect(r.structuredContent.error.code).toBe("ambiguous-format");
      expect(r.structuredContent.error.candidates).toEqual(expect.arrayContaining(["pacscreenelectronics", "pacunicodeunipac"]));
      expect(r.content[0].text).toMatch(/profile\.source\.format \('pac' or 'fpc'\)/);
      const ok = await callTool(h, "convert_subtitle", { path: bin, target: "subrip", profile: { source: { format: "fpc" } } });
      expect(ok.isError).toBeFalsy();
      const named = await callTool(h, "detect_format", { path: put("v12/amb.fpc", bytes) });
      expect(named.structuredContent.id).toBe("pacunicodeunipac");
      const b = await callTool(h, "convert_batch", { paths: [bin], outputDir: path.join(dir, "v12", "batch-amb"), target: "subrip" });
      expect(b.isError).toBe(true);
      expect(b.structuredContent.failures[0].code).toBe("ambiguous-format");
      expect(b.structuredContent.failures[0].candidates).toEqual(expect.arrayContaining(["pacunicodeunipac"]));
    });
  });

  describe("binary milestone (feature-detected)", () => {
    it("SRT→EBU STL→SRT round trip by path", async () => {
      const src = put("bin/a.srt", srt(3, "Round trip"));
      const stl = path.join(dir, "bin", "a.stl");
      const w = await callTool(h, "convert_subtitle", { path: src, target: "ebustl", outputPath: stl });
      expect(w.isError).toBeFalsy();
      expect(fs.readFileSync(stl).subarray(3, 11).toString("latin1")).toMatch(/^STL\d\d\.01$/);
      const back = await callTool(h, "convert_subtitle", { path: stl, target: "subrip" });
      expect(back.isError).toBeFalsy();
      expect(back.content.map((c: any) => c.text ?? "").join("")).toMatch(/Round trip 3/);
    });
    it("invalid-binary-input", async () => {
      const p = put("bin/bad.stl", Buffer.alloc(100, 0x41)); // shorter than the 1024-byte GSI block
      const r = await callTool(h, "convert_subtitle", { path: p, profile: { source: { format: "ebustl" }, target: { format: "subrip" } } });
      expect(r.isError).toBe(true);
      expect(["invalid-binary-input", "format-not-detected"]).toContain(r.structuredContent.error.code);
    });
  });
});
