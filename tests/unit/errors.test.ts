import { describe, it, expect } from "vitest";
import { mapProblem, ToolErrorSchema, type MapContext } from "../../src/errors.js";
import { mapWarnings } from "../../src/tools/common.js";

const ctx: MapContext = { mode: "local", includeDebug: false };
const p = (status: number, code: string, extra: Record<string, unknown> = {}) => ({ type: "t", title: "T", status, code, detail: "d", hint: "API hint.", requestId: "rid", ...extra });

describe("problem mapping (§8.1)", () => {
  const cases: [number, string, string, RegExp | null][] = [
    [400, "invalid-request", "invalid-request", null],
    [400, "invalid-profile", "invalid-profile", /validate_profile/],
    [400, "empty-input", "empty-input", null],
    [400, "format-option-invalid", "format-option-invalid", /formatOptions/],
    [401, "unauthorized", "unauthorized", /Set SUBTITLE_API_KEY/],
    [404, "preset-not-found", "preset-not-found", /list_presets/],
    [404, "not-found", "api-protocol-error", /SUBTITLE_API_URL/],
    [413, "payload-too-large", "payload-too-large", /Split the file/],
    [415, "unsupported-media-type", "api-protocol-error", /Report this/],
    [422, "format-not-detected", "format-not-detected", /profile.source.format/],
    [422, "format-not-supported", "format-not-supported", null],
    [422, "format-not-writable", "format-not-writable", /writableOnly/],
    [422, "invalid-binary-input", "invalid-binary-input", /via path or base64/],
    [422, "encoding-error", "encoding-error", /encoding.input/],
    [422, "unsafe-xml", "unsafe-xml", null],
    [422, "input-limits-exceeded", "input-limits-exceeded", /Split/],
    [422, "format-not-supported", "format-not-supported", /list_formats/],
    [422, "conversion-failed", "conversion-failed", /operation/],
    [422, "frame-rate-required", "frame-rate-required", /Don.t guess the rate/],
    [429, "rate-limited", "rate-limited", /rate limited/],
    [503, "queue-full", "queue-full", /busy/],
    [500, "internal-error", "internal-error", /server bug/],
    [418, "brand-new-code", "brand-new-code", null],
  ];
  it.each(cases)("%i %s → %s", (status, code, expected, hint) => {
    const te = mapProblem(status, p(status, code), ctx);
    expect(te.code).toBe(expected);
    expect(te.status).toBe(status);
    expect(te.source).toBe("api");
    expect(te.requestId).toBe("rid");
    expect(te.hint?.startsWith("API hint.")).toBe(true);
    if (hint) expect(te.hint).toMatch(hint);
  });
  it("retains admitted synchronous job ids without accepting arbitrary job URLs", () => {
    const te = mapProblem(422, p(422, "format-not-detected", { id: "abc123" }), ctx);
    expect(te.jobId).toBe("abc123"); expect(te.jobUrl).toBe("/v1/jobs/abc123");
    expect(mapProblem(422, p(422, "format-not-detected", { id: "https://elsewhere.test/" }), ctx).jobUrl).toBeUndefined();
  });
  it("sidecar 401 hint names the operator", () => {
    expect(mapProblem(401, p(401, "unauthorized"), { ...ctx, mode: "sidecar" }).hint).toMatch(/ask the operator/);
  });
  it("504 phase: queue vs running vs missing", () => {
    expect(mapProblem(504, p(504, "conversion-timeout", { phase: "queue" }), ctx).hint).toMatch(/retry later/);
    expect(mapProblem(504, p(504, "conversion-timeout", { phase: "running" }), ctx).hint).toMatch(/Split the file/);
    expect(mapProblem(504, p(504, "conversion-timeout"), ctx).hint).toMatch(/Split the file/);
  });
  it("404 on /v1/limits is not remapped", () => {
    expect(mapProblem(404, p(404, "not-found"), { ...ctx, endpoint: "/v1/limits" }).code).toBe("not-found");
  });

  it("format-not-supported → list_formats hint (no text-only mode, D-36)", () => {
    expect(mapProblem(422, p(422, "format-not-supported"), ctx).hint).toMatch(/list_formats/);
  });
  it("missing code → http-<status>; missing requestId → header", () => {
    const te = mapProblem(409, { title: "Conflict", status: 409 }, { ...ctx, headerRequestId: "hdr" });
    expect(te.code).toBe("http-409");
    expect(te.requestId).toBe("hdr");
  });
  it("empty-body 400 (legacy binding failure) → api-protocol-error", () => {
    const te = mapProblem(400, undefined, ctx);
    expect(te.code).toBe("api-protocol-error");
    expect(te.title).toBe("http-400");
  });
  it("debug is stripped unless INCLUDE_DEBUG, and always in hosted mode", () => {
    const body = p(422, "conversion-failed", { debug: { operation: "X" } });
    expect(mapProblem(422, body, ctx).debug).toBeUndefined();
    expect(mapProblem(422, body, { ...ctx, includeDebug: true }).debug).toEqual({ operation: "X" });
    expect(mapProblem(422, body, { ...ctx, includeDebug: true, mode: "hosted" }).debug).toBeUndefined();
  });
  it("field errors pass through", () => {
    const te = mapProblem(422, p(422, "storage-location-rejected", { errors: [{ pointer: "/input", message: "not allowed" }] }), ctx);
    expect(te.errors).toEqual([{ pointer: "/input", message: "not allowed" }]);
  });

  it("ambiguous-format: candidates pass through, hint names profile.source.format", () => {
    const te = mapProblem(422, p(422, "ambiguous-format", { candidates: ["pacscreenelectronics", "pacunicodeunipac"], errors: [{ pointer: "/source/format", message: "m" }] }), ctx);
    expect(te.code).toBe("ambiguous-format");
    expect(te.candidates).toEqual(["pacscreenelectronics", "pacunicodeunipac"]);
    expect(te.hint).toMatch(/^API hint\. .*profile\.source\.format \('pac' or 'fpc'\)/);
  });
  it("ambiguous-encoding: candidates and probe pass through; the hint names the option for that probe", () => {
    const pac = mapProblem(422, p(422, "ambiguous-encoding", { candidates: ["pac-greek", "pac-czech"], probe: "pac-code-page", errors: [{ pointer: "/formatOptions/pac/inputCodePage", message: "m" }] }), ctx);
    expect(pac).toMatchObject({ code: "ambiguous-encoding", candidates: ["pac-greek", "pac-czech"], probe: "pac-code-page" });
    expect(pac.errors).toEqual([{ pointer: "/formatOptions/pac/inputCodePage", message: "m" }]);
    expect(pac.hint).toMatch(/^API hint\. Pass profile\.formatOptions\.pac\.inputCodePage/);
    const text = mapProblem(422, p(422, "ambiguous-encoding", { candidates: ["windows-1256", "windows-1252"], probe: "text-encoding" }), ctx);
    expect(text.hint).toMatch(/samples.*profile\.encoding\.input \(only one of candidates\).*tell the user which one you chose.*UTF-8/);
    expect(pac.hint).toBe("API hint. Pass profile.formatOptions.pac.inputCodePage set to only one of the candidates, and tell the user which one you chose.");
    expect(mapProblem(422, p(422, "ambiguous-encoding", { candidates: [], probe: "pac-code-page" }), ctx).hint).toMatch(/No code page produced recognisable words\. Ask the user which code page/);
    const empty = mapProblem(422, p(422, "ambiguous-encoding", { candidates: [], probe: "pac-code-page" }), ctx);
    expect(empty.candidates).toEqual([]);
    const unknown = mapProblem(422, p(422, "ambiguous-encoding", {}), ctx);
    expect(unknown.hint).toMatch(/inputCodePage .*encoding\.input/);
  });
  it("ambiguous-encoding text-encoding: object candidates pass through structurally and read well", () => {
    const te = mapProblem(422, p(422, "ambiguous-encoding", { probe: "text-encoding", candidates: [{ encoding: "windows-1256", language: "ar", hits: 12, sample: "مرحبا", extra: "x" }, { encoding: "windows-1252", language: null, hits: "1", sample: "Ã©" }, 42, { nope: true }] }), ctx);
    expect(te.candidates).toEqual([{ encoding: "windows-1256", language: "ar", hits: 12, sample: "مرحبا" }, { encoding: "windows-1252", language: null, hits: 1, sample: "Ã©" }, "42"]);
    expect(ToolErrorSchema.parse(te).candidates).toEqual(te.candidates);
  });
});

describe("characters-replaced hint", () => {
  const w = (remedy: object) => mapWarnings([{ code: "characters-replaced", message: "m", hint: "API hint.", details: { remedy: { scripts: ["CJK"], currentEncoding: "pac-latin", candidatesTested: true, unicodeAlternative: "fpc", ...remedy } } }])[0];
  it("asks to choose by language only when several values fit and none is suggested", () => {
    expect(w({ candidates: ["chinese-traditional", "chinese-simplified"], suggested: null }).hint).toBe("API hint. Several values fit: choose by the text's language (ask the user if unsure), or use the Unicode alternative (`unicodeAlternative`).");
    expect(w({ candidates: ["greek"], suggested: "greek" }).hint).toBe("API hint.");
    expect(w({}).hint).toBe("API hint.");
  });
});

describe("EBU STL language hint", () => {
  const lang = (value: string, detail?: string) => mapProblem(400, p(400, "format-option-invalid", {
    detail: detail ?? `formatOptions has 1 invalid value(s); first at '/formatOptions/ebuStl/language': '${value}' has no EBU STL language code.`,
    hint: "Use an ISO 639-1 code (sq, br, ca, hr, cy, cs, da, de, en, es, eo, et, ...), a two-digit EBU hex code like \"0A\", or \"auto\".",
    errors: [{ pointer: "/formatOptions/ebuStl/language", message: `'${value}' has no EBU STL language code.`, hint: "Use an ISO 639-1 code (sq, ...)." }],
  }), ctx);
  it("gives the hex code for a known ISO code and the full list, never a cut-off list", () => {
    const te = lang("el");
    expect(te.hint).toMatch(/^Use "70" \(Greek, EBU Tech 3264 Appendix 3\)\. /);
    expect(te.hint).toContain("sq br ca hr cy cs da de en es eo et eu fo fr fy ga gd gl is it la lv lb lt hu mt nl nb no oc pl pt ro rm sr sk sl fi sv tr.");
    expect(te.hint).not.toContain("...");
    expect(te.errors![0].hint).toBe(te.hint);
    expect(lang("RU").hint).toMatch(/^Use "56" \(Russian/);
  });
  it("points to Tech 3264 for an unknown value", () => {
    const te = lang("xx");
    expect(te.hint).toMatch(/^ISO 639-1 codes work only for these languages: /);
    expect(te.hint).toContain('upper case from EBU Tech 3264 Appendix 3 (for example Greek "70"');
  });
  it("keeps the API hint when another field is the first invalid value", () => {
    const te = lang("el", "formatOptions has 2 invalid value(s); first at '/formatOptions/ebuStl/frameRate': bad.");
    expect(te.hint).toMatch(/^Use an ISO 639-1 code \(sq/);
    expect(te.errors![0].hint).toMatch(/^Use "70"/);
  });
});

describe("characters-replaced hint for symbols outside any script", () => {
  const w = (codePoints: string[]) => mapWarnings([{ code: "characters-replaced", message: "m", hint: "Lost characters are outside the known scripts; use target fpc (Unicode PAC), or remove them (operations MultipleReplace).",
    details: { codePoints: codePoints.map((codePoint) => ({ codePoint, count: 1 })), remedy: { scripts: ["other"], currentEncoding: "cp850", candidatesTested: false, unicodeAlternative: "fpc", option: "formatOptions.ebuStl.characterTable", currentValue: "latin" } } }])[0];
  it("leads with a MultipleReplace operation to paste, then the Unicode format", () => {
    const hint = w(["U+2014"]).hint!;
    expect(hint).toBe('No formatOptions.ebuStl.characterTable value keeps \u2014 (U+2014). To keep this format, replace them: add {"id":"MultipleReplace","rules":[{"find":"\u2014","replace":"-"}]} to profile.operations, then convert again. Only if the delivery accepts another format, use target fpc (Unicode).');
  });
  it("an unknown symbol gets an empty replace and says so", () => {
    expect(w(["U+2122"]).hint).toContain('{"find":"\u2122","replace":""}');
    expect(w(["U+2122"]).hint).toContain("an empty replace removes the character");
  });
  it("a script loss keeps the API hint", () => {
    const x = mapWarnings([{ code: "characters-replaced", message: "m", hint: "API hint.", details: { codePoints: [{ codePoint: "U+03B1", count: 1 }], remedy: { scripts: ["Greek"], currentEncoding: "cp850", candidatesTested: true, unicodeAlternative: "fpc" } } }])[0];
    expect(x.hint).toBe("API hint.");
  });
});
