import { describe, it, expect } from "vitest";
import {
  checkCursor, clampPageBytes, decodeCursor, encodeCursor, fingerprint, hashKey, segment, stripBom, takePage, PREVIEW_MIN_BYTES,
} from "../../src/tools/textPage.js";
import { ToolFailure } from "../../src/errors.js";

const cue = (n: number, text = "Hello") => `${n}\n00:00:${String(n).padStart(2, "0")},000 --> 00:00:${String(n).padStart(2, "0")},500\n${text}\n\n`;
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as ToolFailure).toolError.code; } return undefined; };

/** Reads every page from the start and returns them. */
function allPages(text: string, maxBytes: number, cueFormat = true) {
  const s = segment(text, cueFormat);
  const pages = [];
  let start = 0;
  for (;;) { const p = takePage(s, start, maxBytes); pages.push(p); if (!p.more) break; start = p.end; }
  return { s, pages };
}

describe("segment", () => {
  it("splits SRT into whole cues (CRLF too) and concatenates back exactly", () => {
    const srt = "1\r\n00:00:01,000 --> 00:00:02,000\r\nA\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nB\r\n";
    const s = segment(srt, true);
    expect(s.unit).toBe("cue"); expect(s.parts).toHaveLength(2); expect(s.parts.join("")).toBe(srt);
    expect(s.totalBytes).toBe(bytes(srt));
  });
  it("attaches a WebVTT header to the first cue and stray blocks to the previous cue", () => {
    const vtt = "WEBVTT\n\nNOTE hi\n\n00:01.000 --> 00:02.000\nA\n\nloose line\n\n00:03.000 --> 00:04.000\nB\n";
    const s = segment(vtt, true);
    expect(s.parts).toEqual(["WEBVTT\n\nNOTE hi\n\n00:01.000 --> 00:02.000\nA\n\nloose line\n\n", "00:03.000 --> 00:04.000\nB\n"]);
  });
  it("falls back to lines for non-cue formats or text without timing lines", () => {
    expect(segment('{\n "a": 1\n}', false)).toMatchObject({ unit: "line", parts: ["{\n", ' "a": 1\n', "}"] });
    expect(segment("no timing\n\nhere\n", true).unit).toBe("line");
    expect(segment("", true)).toMatchObject({ unit: "line", parts: [], totalBytes: 0 });
  });
  it("counts UTF-8 bytes without a BOM", () => {
    const t = stripBom("\uFEFF" + cue(1, "é"));
    expect(t.startsWith("1")).toBe(true); expect(segment(t, true).totalBytes).toBe(bytes(cue(1, "é")));
  });
});

describe("takePage", () => {
  const five = [1, 2, 3, 4, 5].map((n) => cue(n)).join(""); // each cue is the same size
  const c = bytes(cue(1));

  it("ends every page on a whole cue and never exceeds maxBytes", () => {
    const { pages } = allPages(five, 2 * c + 5);
    expect(pages.map((p) => [p.start, p.end])).toEqual([[0, 2], [2, 4], [4, 5]]);
    for (const p of pages) { expect(p.returnedBytes).toBeLessThanOrEqual(2 * c + 5); expect(p.text.endsWith("\n")).toBe(true); expect(bytes(p.text)).toBe(p.returnedBytes); }
    expect(pages.map((p) => p.text).join("")).toBe(five);
  });
  it("exact fit: a page of exactly maxBytes is full, and the next cue starts the next page", () => {
    const { pages } = allPages(five, 2 * c);
    expect(pages[0]).toMatchObject({ start: 0, end: 2, returnedBytes: 2 * c, more: true });
    expect(allPages(five, 2 * c - 1).pages[0]).toMatchObject({ end: 1, returnedBytes: c });
  });
  it("last page: more is false; a file that fits is one page", () => {
    const { pages } = allPages(five, 2 * c);
    expect(pages.at(-1)).toMatchObject({ start: 4, end: 5, more: false });
    expect(allPages(five, 10 * c).pages).toEqual([{ text: five, start: 0, end: 5, returnedBytes: 5 * c, more: false }]);
  });
  it("returns a single cue larger than maxBytes alone, then continues normally", () => {
    const big = cue(2, "x".repeat(500));
    const text = cue(1) + big + cue(3) + cue(4);
    const { pages } = allPages(text, 2 * c + 1);
    expect(pages.map((p) => p.text)).toEqual([cue(1), big, cue(3) + cue(4)]);
    expect(pages[1].returnedBytes).toBe(bytes(big));
  });
  it("never splits a multibyte character", () => {
    const text = [1, 2, 3].map((n) => cue(n, "नमस्ते दुनिया")).join("");
    for (const p of allPages(text, bytes(cue(1, "नमस्ते दुनिया")) + 3).pages) expect(Buffer.from(p.text, "utf8").toString("utf8")).toBe(p.text);
  });
});

describe("clampPageBytes", () => {
  it("defaults, raises small requests to the minimum and lowers large ones to the server max", () => {
    expect(clampPageBytes(undefined, 65536, 262144)).toBe(65536);
    expect(clampPageBytes(1, 65536, 262144)).toBe(PREVIEW_MIN_BYTES);
    expect(clampPageBytes(10_000_000, 65536, 262144)).toBe(262144);
    expect(clampPageBytes(100_000, 65536, 262144)).toBe(100_000);
  });
});

describe("cursor", () => {
  const data = Buffer.from("stored bytes");
  const s = segment([1, 2, 3].map((n) => cue(n)).join(""), true);
  const key = hashKey("job:abc:output");

  it("round-trips as an opaque base64url string", () => {
    const c = { k: key, h: fingerprint(data), u: "cue" as const, f: 2 };
    const enc = encodeCursor(c);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/); expect(decodeCursor(enc)).toEqual(c);
    expect(() => checkCursor(c, key, fingerprint(data), s)).not.toThrow();
  });
  it("rejects garbage and cursors for another file as preview-cursor-invalid", () => {
    expect(code(() => decodeCursor("not-a-cursor"))).toBe("preview-cursor-invalid");
    expect(code(() => decodeCursor(encodeCursor({ k: key, h: "x", u: "cue", f: 0 })))).toBe("preview-cursor-invalid");
    const c = decodeCursor(encodeCursor({ k: hashKey("job:abc:input"), h: fingerprint(data), u: "cue", f: 1 }));
    expect(code(() => checkCursor(c, key, fingerprint(data), s))).toBe("preview-cursor-invalid");
  });
  it("reports a fingerprint mismatch (and only that) as preview-source-changed", () => {
    const c = { k: key, h: fingerprint(data), u: "cue" as const, f: 1 };
    expect(code(() => checkCursor(c, key, fingerprint(Buffer.from("changed")), s))).toBe("preview-source-changed");
  });
  it("treats a forged past-end index or switched unit as preview-cursor-invalid", () => {
    const c = { k: key, h: fingerprint(data), u: "cue" as const, f: 1 };
    expect(code(() => checkCursor({ ...c, f: 3 }, key, fingerprint(data), s))).toBe("preview-cursor-invalid");
    expect(code(() => checkCursor({ ...c, u: "line" }, key, fingerprint(data), s))).toBe("preview-cursor-invalid");
  });
  it("rejects empty, too long and wrongly-charactered cursors as preview-cursor-invalid", () => {
    const good = encodeCursor({ k: key, h: fingerprint(data), u: "cue", f: 1 });
    for (const bad of ["", "a b", good + "+", good + "=", "x".repeat(513), good.slice(0, -3)]) expect(code(() => decodeCursor(bad)), bad.slice(0, 20)).toBe("preview-cursor-invalid");
  });
});
