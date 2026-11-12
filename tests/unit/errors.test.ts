import { describe, it, expect } from "vitest";
import { mapProblem, ToolErrorSchema, type MapContext } from "../../src/errors.js";

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
    expect(text.hint).toMatch(/profile\.encoding\.input .*UTF-8/);
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
