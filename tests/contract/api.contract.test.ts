/**
 * Contract suite against a real converter API (§14), the version this MCP targets (D-36/D-37). Gated on CONTRACT_API_URL.
 *   CONTRACT_API_URL      e.g. http://127.0.0.1:8080 (the API's Compose host port)
 *   CONTRACT_API_KEY      key configured on the API (second run)
 *   CONTRACT_SMALL_LIMITS "1" when the API runs with MAX_UPLOAD_BYTES=1048576
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
  let hasList = false; // the API reports storage.extensions (older APIs don't: the MCP skips the check and warns)
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
    const limits: any = await (await fetch(`${URL_}/v1/limits`, { headers: KEY ? { authorization: `Bearer ${KEY}` } : {} })).json().catch(() => undefined);
    hasList = Array.isArray(limits?.storage?.extensions);
  });

  it("local files: checked against the API's extension list, or unchecked with a warning on older APIs", async () => {
    const r = await callTool(h, "detect_format", { path: put("local/check.srt") });
    expect(r.isError, JSON.stringify(r.structuredContent?.error)).toBeFalsy();
    if (hasList) expect(r.content[0].text).not.toContain("mcp-extension-check-skipped");
    else expect(r.content[0].text).toContain("Warning mcp-extension-check-skipped");
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
      expect(JSON.parse(r.contents[0].text).maxUploadBytes).toBeGreaterThan(0);
    });
  });

  describe("single file", () => {
    it("SRT→VTT inline and to disk byte-exact vs direct API output", async () => {
      const inline = await callTool(h, "convert_subtitle", { content: SRT, fileName: "a.srt", target: "webvtt" });
      expect(inline.isError).toBeFalsy();
      const res = inline.content.find((c: any) => c.type === "resource")?.resource;
      expect(res?.text?.replace(/^\uFEFF/, "")).toMatch(/^WEBVTT/);
      expect(inline.structuredContent.outputs[0].attached).toBe(true);
      expect(Buffer.byteLength(res.text, "utf8")).toBe(inline.structuredContent.outputs[0].bytes);
      const src = put("single/a.srt");
      const out = path.join(dir, "single", "a.vtt");
      const disk = await callTool(h, "convert_subtitle", { path: src, target: "webvtt", outputPath: out });
      expect(disk.structuredContent.outputs[0]).toMatchObject({ writtenTo: out, action: "written" });
      const ref = await direct({ content: Buffer.from(SRT).toString("base64"), contentEncoding: "base64", fileName: "a.srt", target: "webvtt", responseEncoding: "base64" });
      expect(fs.readFileSync(out).equals(Buffer.from(ref.outputs[0].content, "base64"))).toBe(true);
      expect(Buffer.from(res.text, "utf8").equals(Buffer.from(ref.outputs[0].content, "base64"))).toBe(true); // inline resource = stored/written bytes, BOM included
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
    it("write flow: existing outputPath under error → no request; replace", async () => {
      const src = put("wf/a.srt");
      const out = put("wf/a.vtt", "old");
      const e = await callTool(h, "convert_subtitle", { path: src, target: "webvtt", outputPath: out });
      expect(e.structuredContent.error.code).toBe("output-exists");
      expect(e.structuredContent.attempts ?? 0).toBe(0);
      expect(fs.readFileSync(out, "utf8")).toBe("old");
      const hd = await mk();
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

  describe("jobs and API locations", () => {
    it("exposes a job id for synchronous conversion and retains only metadata", async () => {
      const r = await callTool(h, "convert_subtitle", { content: SRT, target: "vtt" });
      expect(r.structuredContent.jobId).toMatch(/^[a-f0-9]{32}$/);
      const response = await fetch(`${URL_}/v1/jobs/${r.structuredContent.jobId}`, { headers: KEY ? { authorization: `Bearer ${KEY}` } : {} });
      const job: any = await response.json();
      expect(job.status).toBe("succeeded"); expect(job.result.outputs[0].content).toBeUndefined();
      expect((await h.client.listTools()).tools.some((t) => t.name === "convert_batch")).toBe(false);
    });
    it("preview_text explains response-only jobs and forgotten ids", async () => {
      const result = await callTool(h, "convert_subtitle", { content: SRT, target: "vtt" });
      for (const which of ["input", "output"] as const) {
        const missing = await callTool(h, "preview_text", { jobId: result.structuredContent.jobId, which });
        expect(missing.structuredContent.error.code).toBe(which === "input" ? "job-input-not-stored" : "job-output-not-stored");
        expect(missing.structuredContent.error.jobId).toBe(result.structuredContent.jobId);
      }
      const unknown = await callTool(h, "preview_text", { jobId: "00000000000000000000000000000000", which: "output" });
      expect(unknown.structuredContent.error.code).toBe("job-not-found");
    });
    it("Prefer wait=0 returns 202 and a retrievable terminal job", async () => {
      const response = await fetch(`${URL_}/v1/convert/json`, { method: "POST", headers: { "content-type": "application/json", Prefer: "wait=0", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) }, body: JSON.stringify({ content: SRT, target: "vtt" }) });
      expect(response.status).toBe(202);
      const accepted: any = await response.json(); expect(response.headers.get("location")).toBe(`/v1/jobs/${accepted.id}`);
      let job: any;
      for (let i = 0; i < 100; i++) {
        const r = await fetch(`${URL_}/v1/jobs/${accepted.id}`, { headers: KEY ? { authorization: `Bearer ${KEY}` } : {} }); job = await r.json();
        if (job.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(job.status).toBe("succeeded");
    });
    it.skipIf(!process.env.CONTRACT_STORAGE_ROOT)("passes API filesystem input/output and sidecar", async () => {
      const root = process.env.CONTRACT_STORAGE_ROOT!;
      const source = path.join(root, `contract-${Date.now()}.srt`), output = source + ".vtt";
      fs.writeFileSync(source, SRT);
      try {
        const d = await callTool(h, "detect_format", { input: source }); expect(d.structuredContent.id).toBe("subrip");
        const r = await callTool(h, "convert_subtitle", { input: source, output, sidecar: true, target: "vtt" });
        expect(r.isError).toBeFalsy(); expect(r.structuredContent.outputs[0].output).toBe(output);
        expect(fs.readFileSync(output, "utf8")).toContain("WEBVTT"); expect(fs.existsSync(output + ".json")).toBe(true);
        for (const which of ["input", "output"] as const) {
          const file = await callTool(h, "preview_text", { jobId: r.structuredContent.jobId, which });
          expect(file.isError).toBeFalsy(); expect(file.structuredContent.which).toBe(which);
          expect(file.structuredContent.bytes).toBe(fs.statSync(which === "input" ? source : output).size);
          expect(file.structuredContent.text).toContain(which === "input" ? "Hello" : "WEBVTT");
        }
        const collision = await callTool(h, "convert_subtitle", { input: source, output, target: "vtt" });
        expect(collision.structuredContent.error.code).toBe("output-exists"); expect(collision.structuredContent.error.hint).toContain("error | replace");
        const replaced = await callTool(h, "convert_subtitle", { input: source, output, sidecar: true, target: "vtt", ifExists: "replace" });
        expect(replaced.isError).toBeFalsy();
        fs.unlinkSync(output);
        const gone = await callTool(h, "preview_text", { jobId: r.structuredContent.jobId, which: "output" });
        expect(gone.structuredContent.error.code).toBe("job-file-gone"); expect(gone.structuredContent.error.location).toBe(new URL(`file://${output}`).href);

      } finally { for (const f of [source, output, output + ".json"]) fs.rmSync(f, { force: true }); }
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


  describe("1.2.0: verification, actionable warnings, source diagnostics, ambiguous-format", () => {
    const GREEK = "1\n00:00:01,000 --> 00:00:02,500\nΚαλημέρα κόσμε\n\n2\n00:00:03,000 --> 00:00:04,000\nΕίναι μια δοκιμή\n\n3\n00:00:05,000 --> 00:00:06,000\nΤέλος της δοκιμής\n";
    const ZERO = "1\n00:00:00,000 --> 00:00:00,000\nmeta\n\n2\n00:00:01,000 --> 00:00:02,000\nHello\n\n3\n00:00:03,000 --> 00:00:04,000\nWorld\n";
    it("SRT→PAC Greek: lossy verification with replaced chars by cue/code point, actionable hint; codePage greek → quantised", async () => {
      const src = put("v12/greek.srt", GREEK);
      const r = await callTool(h, "convert_subtitle", { path: src, target: "pac", profile: { target: { fps: 25 } }, outputDir: path.join(dir, "v12", "pac-latin") });
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
      // 1.2.1: remedy facts
      expect(w.details.remedy).toMatchObject({ option: "formatOptions.pac.codePage", currentValue: "latin", suggested: "greek", candidates: ["greek"], candidatesTested: true, unicodeAlternative: "fpc" });
      expect(w.details.remedy.allowedValues).toEqual(expect.arrayContaining(["latin", "greek", "czech", "turkish"]));
      expect(r.content[0].text).toMatch(/Verification of greek\.pac: lossy: 3\/3 cues read back; \d+ char\(s\) replaced in cue\(s\) 1, 2, 3/);
      const g = await callTool(h, "convert_subtitle", { path: src, profile: { target: { format: "pac", fps: 25 }, formatOptions: { pac: { codePage: "greek" } } }, outputDir: path.join(dir, "v12", "pac-greek") });
      expect(g.structuredContent.outputs[0].verification.verdict).toMatch(/^(quantised|lossless)$/);
    });
    it("1.2.1: several tested candidates (traditional Chinese → PAC) are listed, none suggested; Polish → PAC is lossless", async () => {
      const r = await callTool(h, "convert_subtitle", { content: "1\n00:00:01,000 --> 00:00:02,000\n這是測試\n", fileName: "tw.srt", target: "pac", profile: { target: { fps: 25 } } });
      expect(r.isError).toBeFalsy();
      const rm = r.structuredContent.warnings.find((x: any) => x.code === "characters-replaced").details.remedy;
      expect(rm.suggested).toBeUndefined();
      expect(rm.candidatesTested).toBe(true);
      expect(rm.candidates).toEqual(expect.arrayContaining(["chinese-traditional", "chinese-simplified"]));
      expect(rm.candidates.length).toBeGreaterThan(1);
      const pl = await callTool(h, "convert_subtitle", { content: "1\n00:00:01,000 --> 00:00:02,000\nZażółć gęślą jaźń\n", fileName: "pl.srt", target: "pac", profile: { target: { fps: 25 } } });
      expect(pl.structuredContent.outputs[0].verification.verdict).toBe("lossless");
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
      // A local .bin file is not a subtitle file name, so the MCP never reads it (H3); inline content has no such rule.
      if (hasList) expect((await callTool(h, "convert_subtitle", { path: put("v12/amb.bin", bytes), target: "subrip" })).structuredContent.error.code).toBe("extension-not-allowed");
      const inline = { content: bytes.toString("base64"), contentEncoding: "base64", fileName: "amb.bin", target: "subrip" };
      const r = await callTool(h, "convert_subtitle", inline);
      expect(r.isError).toBe(true);
      expect(r.structuredContent.error.code).toBe("ambiguous-format");
      expect(r.structuredContent.error.candidates).toEqual(expect.arrayContaining(["pacscreenelectronics", "pacunicodeunipac"]));
      expect(r.content[0].text).toMatch(/profile\.source\.format \('pac' or 'fpc'\)/);
      const ok = await callTool(h, "convert_subtitle", { ...inline, profile: { source: { format: "fpc", fps: 25 } } });
      expect(ok.isError).toBeFalsy();
      const named = await callTool(h, "detect_format", { path: put("v12/amb.fpc", bytes) });
      expect(named.structuredContent.id).toBe("pacunicodeunipac");

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
      expect(back.content.map((c: any) => c.resource?.text ?? "").join("")).toMatch(/Round trip 3/);
    });
    it("invalid-binary-input", async () => {
      const p = put("bin/bad.stl", Buffer.alloc(100, 0x41)); // shorter than the 1024-byte GSI block
      const r = await callTool(h, "convert_subtitle", { path: p, profile: { source: { format: "ebustl" }, target: { format: "subrip" } } });
      expect(r.isError).toBe(true);
      expect(["invalid-binary-input", "format-not-detected"]).toContain(r.structuredContent.error.code);
    });
  });
});
