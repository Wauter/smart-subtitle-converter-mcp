import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { isValidBase64, decodedBase64Length } from "../../src/base64.js";
import { toInt, toOptInt } from "../../src/api/coerce.js";
import { newCallId, withSuffix, REQUEST_ID_RE, ulid } from "../../src/ids.js";
import { normalizeLimits } from "../../src/api/limits.js";
import { parseArgs, parseDirList, parseHostPort, ConfigError } from "../../src/config.js";
import { createLogger, redact } from "../../src/log.js";

describe("base64 + coercion", () => {
  it("validates base64 strictly", () => {
    expect(isValidBase64("QUJD")).toBe(true);
    expect(isValidBase64("QUI=")).toBe(true);
    expect(isValidBase64("")).toBe(true);
    for (const bad of ["QUJ", "QU JD", "QU=D", "Q===", "QUJD\n", "QUJ-"]) expect(isValidBase64(bad)).toBe(false);
    expect(decodedBase64Length("QUI=")).toBe(2);
  });
  it("coerces integer|string", () => {
    expect(toInt("812")).toBe(812);
    expect(toInt(5)).toBe(5);
    expect(toInt("x", 3)).toBe(3);
    expect(toOptInt(null)).toBeUndefined();
    expect(toOptInt("100.5")).toBe(100.5);
  });
});

describe("request ids", () => {
  it("mcp-<ULID> with suffixes capped at 64", () => {
    const id = newCallId();
    expect(id).toHaveLength(30);
    expect(REQUEST_ID_RE.test(id)).toBe(true);
    expect(withSuffix(id, ".c2.r1")).toBe(id + ".c2.r1");
    const long = withSuffix("x".repeat(64), ".c12a.r3");
    expect(long.length).toBe(64);
    expect(long.endsWith(".c12a.r3")).toBe(true);
    expect(ulid(0).slice(0, 10)).toBe("0000000000");
  });
});

describe("limits normalisation", () => {
  it("reads the shipped contract with string numbers", () => {
    const l = normalizeLimits({ maxUploadBytes: "10485760", maxRequestBodyBytes: { multipart: 1, json: "14112088" }, json: { maxDecodedContentBytes: 10485760 }, maxCues: "100" });
    expect([l.maxUploadBytes, l.bodyJson, l.jsonMaxDecoded, l.maxCues]).toEqual([10485760, 14112088, 10485760, 100]);
  });
});

describe("config", () => {
  const env = { SUBTITLE_API_URL: "http://api:8080" };
  const cfg = (argv: string[], e: Record<string, string> = {}) => {
    const r = parseArgs(argv, { ...env, ...e }, { checkFiles: false });
    if (r.kind !== "config") throw new Error("not config");
    return r.config;
  };
  const err = (argv: string[], e: Record<string, string | undefined> = {}) => {
    try {
      parseArgs(argv, { ...env, ...e } as NodeJS.ProcessEnv, { checkFiles: false });
      return "ok";
    } catch (x) {
      return x instanceof ConfigError ? x.message : String(x);
    }
  };
  const token = "t".repeat(32);
  it("defaults to local stdio", () => {
    const c = cfg([]);
    expect(c.mode).toBe("local");
    expect(c.timeoutMs).toBe(120000);
  });

  it("--http needs a long enough token; flags override env", () => {
    expect(err(["--http", "3000"])).toMatch(/inbound access token/);
    expect(err(["--http", "3000"], { SUBTITLE_MCP_HTTP_TOKEN: "short" })).toMatch(/at least 32/);
    const c = cfg(["--http", "0.0.0.0:3001", "--api-url", "http://other"], { SUBTITLE_MCP_HTTP_TOKEN: token });
    expect(c.mode).toBe("sidecar");
    expect(c.http).toEqual({ host: "0.0.0.0", port: 3001 });
    expect(c.apiUrl).toBe("http://other");
  });
  it("rejects invalid values, unknown vars, both key sources and hosted", () => {
    expect(err([], { SUBTITLE_API_URL: undefined })).toMatch(/required/);
    expect(err([], { SUBTITLE_API_URL: "ftp://x" })).toMatch(/http or https/);
    expect(err([], { SUBTITLE_MCP_TIMEOUT_MS: "abc" })).toMatch(/integer/);
    expect(err([], { SUBTITLE_MCP_ALLOW_OVERWRITE: "true" })).toMatch(/unknown environment variable/);
    expect(err([], { SUBTITLE_API_KEY: "a", SUBTITLE_API_KEY_FILE: "/x" })).toMatch(/not both/);
    expect(err(["--hosted"])).toMatch(/needs --http/);
    expect(err(["--hosted", "--http", "3000"])).toMatch(/hosted auth provider/);
    expect(err(["--bogus"])).toMatch(/unknown argument/);
  });
  it("dir lists: delimiter or JSON array", () => {
    expect(parseDirList("/a:/b", ":")).toEqual(["/a", "/b"]);
    expect(parseDirList("C:\\a;D:\\b", ";")).toEqual(["C:\\a", "D:\\b"]);
    expect(parseDirList('["/a:b","/c"]')).toEqual(["/a:b", "/c"]);
    expect(parseHostPort("3000")).toEqual({ host: "127.0.0.1", port: 3000 });
    expect(parseHostPort("[::1]:3000")).toEqual({ host: "::1", port: 3000 });
  });
  it("adds the bind host to the Host allowlist", () => {
    expect(cfg(["--http", "mcp.local:3000"], { SUBTITLE_MCP_HTTP_TOKEN: token }).allowedHosts).toContain("mcp.local");
  });
});

describe("logging", () => {
  it("redacts secrets structurally and hashes paths", () => {
    const lines: string[] = [];
    const log = createLogger("info", false, (l) => lines.push(l));
    log.info("x", { headers: { Authorization: "Bearer s3cret" }, nested: { token: "abc" } });
    expect(lines[0]).not.toContain("s3cret");
    expect(lines[0]).not.toContain("abc");
    expect(log.p("/data/in/movie.srt")).toMatch(/^[0-9a-f]{12}\.srt$/);
    expect(redact({ apiKey: "k" })).toEqual({ apiKey: "[redacted]" });
  });
});



describe("version check (D-37/D-43)", () => {
  it("compatible = same major.minor as the MCP's own version", async () => {
    const { versionCompatible, EXPECTED_API_VERSION } = await import("../../src/api/info.js");
    const { VERSION } = await import("../../src/version.js");
    expect(EXPECTED_API_VERSION).toBe(VERSION);
    expect(versionCompatible("1.1.0", "1.1.0")).toBe(true);
    expect(versionCompatible("1.1.7", "1.1.0")).toBe(true);
    expect(versionCompatible("1.0.0", "1.1.0")).toBe(false);
    expect(versionCompatible("1.2.0", "1.1.0")).toBe(false);
    expect(versionCompatible("2.1.0", "1.1.0")).toBe(false);
    expect(versionCompatible(undefined, "1.1.0")).toBe(false);
  });
  it("probeApi logs api.version and warns only on a mismatch", async () => {
    const { probeApi } = await import("../../src/probe.js");
    const { apiInfo, EXPECTED_API_VERSION } = await import("../../src/api/info.js");
    const { createLogger } = await import("../../src/log.js");
    const [maj, min] = EXPECTED_API_VERSION.split(".");
    for (const [v, warn] of [[`${maj}.${min}.9`, false], ["1.0.0", true]] as const) {
      const lines: string[] = [];
      const log = createLogger("debug", false, (l) => lines.push(l));
      const f = (async () => new Response(JSON.stringify({ status: "ok", version: v, libse: "5.1.0" }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
      apiInfo.probedAt = undefined;
      await probeApi({ apiUrl: "http://x" }, log, f);
      expect(lines.some((l) => l.includes(`"api.version":"${v}"`) && l.includes('"level":"info"'))).toBe(true);
      expect(lines.some((l) => l.includes('"level":"warn"') && l.includes("not compatible"))).toBe(warn);
      expect(apiInfo.versionMismatch).toBe(warn);
    }
    apiInfo.versionMismatch = false;
  });
  it("API 1.1.x is compatible with any MCP 1.1.x (e.g. API 1.1.1 with MCP 1.1.2): no mismatch warning", async () => {
    const { versionCompatible } = await import("../../src/api/info.js");
    expect(versionCompatible("1.1.1", "1.1.2")).toBe(true);
    expect(versionCompatible("1.1.0", "1.1.2")).toBe(true);
    expect(versionCompatible("1.2.0", "1.1.2")).toBe(false);
  });
  it("package.json carries the shared 1.3 version line (pairs with API 1.3.x) and stays private", async () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.version).toMatch(/^1\.3\.\d+$/);
    expect(pkg.private).toBe(true);
  });
});

