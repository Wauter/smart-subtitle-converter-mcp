import fs from "node:fs";
import path from "node:path";
import type { LogLevel } from "./log.js";
import type { Mode } from "./errors.js";
import { PREVIEW_HARD_CEILING_BYTES, PREVIEW_MIN_BYTES } from "./tools/textPage.js";

export class ConfigError extends Error {}

export interface Config {
  mode: Mode;
  apiUrl: string;
  apiKey?: string;
  apiKeyFile?: string;
  httpTokens: string[];
  httpTokenFile?: string;
  http?: { host: string; port: number };
  allowedDirs: string[];
  readonlyDirs: string[];
  useClientRoots: boolean;
  partialMaxAgeMs: number;
  maxBytes?: number;
  timeoutMs: number;
  retryMaxAttempts: number;
  retryMaxWaitMs: number;
  retryBudgetMs: number;
  /** preview_text page size when the call gives no maxBytes (UTF-8 bytes). */
  previewDefaultBytes: number;
  /** Largest preview_text page (and largest single cue) returned, in UTF-8 bytes. */
  previewMaxBytes: number;
  jsonMaxDecodedBytes?: number;
  limitsTtlMs: number;
  includeDebug: boolean;
  allowedOrigins: string[];
  allowedHosts: string[];
  logLevel: LogLevel;
  logPaths: boolean;
}

const KNOWN_ENV = new Set([
  "SUBTITLE_API_URL", "SUBTITLE_API_KEY", "SUBTITLE_API_KEY_FILE", "SUBTITLE_MCP_HTTP_TOKEN", "SUBTITLE_MCP_HTTP_TOKEN_FILE",
  "SUBTITLE_MCP_HTTP", "SUBTITLE_MCP_HOSTED", "SUBTITLE_MCP_ALLOWED_DIRS", "SUBTITLE_MCP_READONLY_DIRS",
  "SUBTITLE_MCP_USE_CLIENT_ROOTS", "SUBTITLE_MCP_PARTIAL_MAX_AGE_MS", "SUBTITLE_MCP_MAX_BYTES",
  "SUBTITLE_MCP_TIMEOUT_MS", "SUBTITLE_MCP_RETRY_MAX_ATTEMPTS", "SUBTITLE_MCP_RETRY_MAX_WAIT_MS", "SUBTITLE_MCP_RETRY_BUDGET_MS",
  "SUBTITLE_MCP_PREVIEW_DEFAULT_BYTES", "SUBTITLE_MCP_PREVIEW_MAX_BYTES",
  "SUBTITLE_MCP_JSON_MAX_DECODED_BYTES", "SUBTITLE_MCP_LIMITS_TTL_MS",
  "SUBTITLE_MCP_INCLUDE_DEBUG", "SUBTITLE_MCP_ALLOWED_ORIGINS", "SUBTITLE_MCP_ALLOWED_HOSTS", "SUBTITLE_MCP_LOG_LEVEL",
  "SUBTITLE_MCP_LOG_PATHS",
]);

export const USAGE = `Usage: smart-subtitle-converter-mcp [options]

  --api-url <url>        Smart Subtitle Converter API base URL (env SUBTITLE_API_URL, required)
  --http [host:]port     Streamable HTTP on /mcp instead of stdio (env SUBTITLE_MCP_HTTP)
  --hosted               Hosted hardening (needs --http; not available in v1)
  --allow-dir <dir>      Read-write root (repeatable; env SUBTITLE_MCP_ALLOWED_DIRS)
  --allow-dir-ro <dir>   Read-only root (repeatable; env SUBTITLE_MCP_READONLY_DIRS)
  --log-level <level>    error|warn|info|debug (env SUBTITLE_MCP_LOG_LEVEL)
  --version, --help

See README.md for every SUBTITLE_MCP_* environment variable.`;

function bool(name: string, v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  if (/^(true|1|yes)$/i.test(v)) return true;
  if (/^(false|0|no)$/i.test(v)) return false;
  throw new ConfigError(`${name}: expected true or false, got '${v}'`);
}

function int(name: string, v: string | undefined, def: number | undefined, min = 0): number | undefined {
  if (v === undefined || v === "") return def;
  if (!/^\d+$/.test(v.trim())) throw new ConfigError(`${name}: expected a non-negative integer, got '${v}'`);
  const n = Number(v.trim());
  if (!Number.isSafeInteger(n) || n < min) throw new ConfigError(`${name}: must be an integer >= ${min}`);
  return n;
}

/** List of dirs: JSON array if it starts with '[', else split on path.delimiter. */
export function parseDirList(v: string | undefined, delimiter = path.delimiter): string[] {
  if (!v || !v.trim()) return [];
  const t = v.trim();
  if (t.startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(t);
    } catch {
      throw new ConfigError("directory list: invalid JSON array");
    }
    if (!Array.isArray(arr) || arr.some((x) => typeof x !== "string")) throw new ConfigError("directory list: expected a JSON array of strings");
    return (arr as string[]).filter((x) => x.trim() !== "");
  }
  return t.split(delimiter).map((s) => s.trim()).filter(Boolean);
}

export function parseHostPort(v: string): { host: string; port: number } {
  const t = v.trim();
  let host = "127.0.0.1";
  let portStr = t;
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(t) ?? /^([^:]*):(\d+)$/.exec(t);
  if (m) {
    host = m[1] || "127.0.0.1";
    portStr = m[2];
  }
  if (!/^\d+$/.test(portStr)) throw new ConfigError(`--http: expected [host:]port, got '${v}'`);
  const port = Number(portStr);
  if (port < 0 || port > 65535) throw new ConfigError(`--http: port out of range: ${port}`);
  return { host, port };
}

function list(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function readSecretFile(file: string, what: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new ConfigError(`${what}: file is missing or unreadable`);
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) throw new ConfigError(`${what}: file is empty`);
  return lines;
}

export type ParseResult = { kind: "config"; config: Config } | { kind: "help" } | { kind: "version" };

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv, opts: { checkFiles?: boolean } = {}): ParseResult {
  const checkFiles = opts.checkFiles ?? true;
  let apiUrl = env.SUBTITLE_API_URL;
  let httpArg = env.SUBTITLE_MCP_HTTP;
  let hosted = bool("SUBTITLE_MCP_HOSTED", env.SUBTITLE_MCP_HOSTED, false);
  const cliAllow: string[] = [];
  const cliRo: string[] = [];
  let logLevel = env.SUBTITLE_MCP_LOG_LEVEL || "info";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const next = (): string => {
      if (inline !== undefined) return inline;
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new ConfigError(`${flag}: missing value`);
      return v;
    };
    switch (flag) {
      case "--help": case "-h": return { kind: "help" };
      case "--version": case "-v": return { kind: "version" };
      case "--api-url": apiUrl = next(); break;
      case "--http": {
        if (inline !== undefined) httpArg = inline;
        else if (argv[i + 1] && !argv[i + 1].startsWith("--")) httpArg = argv[++i];
        else httpArg = "127.0.0.1:3000";
        break;
      }
      case "--hosted": hosted = true; break;
      case "--allow-dir": cliAllow.push(next()); break;
      case "--allow-dir-ro": cliRo.push(next()); break;
      case "--log-level": logLevel = next(); break;
      default: throw new ConfigError(`unknown argument '${a}'`);
    }
  }

  for (const k of Object.keys(env)) {
    if (k === "SUBTITLE_MCP_INLINE_TEXT_MAX_BYTES")
      throw new ConfigError("SUBTITLE_MCP_INLINE_TEXT_MAX_BYTES was removed: convert_subtitle returns the whole file again, and preview_text pages its text. Remove it; to change the preview page size use SUBTITLE_MCP_PREVIEW_DEFAULT_BYTES / SUBTITLE_MCP_PREVIEW_MAX_BYTES");
    if (k.startsWith("SUBTITLE_MCP_") && !KNOWN_ENV.has(k)) throw new ConfigError(`unknown environment variable ${k}`);
  }

  if (!apiUrl) throw new ConfigError("SUBTITLE_API_URL (or --api-url) is required");
  let u: URL;
  try {
    u = new URL(apiUrl);
  } catch {
    throw new ConfigError("SUBTITLE_API_URL: not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ConfigError("SUBTITLE_API_URL: must be http or https");
  if (u.search || u.hash) throw new ConfigError("SUBTITLE_API_URL: must not contain a query or fragment");

  if (!["error", "warn", "info", "debug"].includes(logLevel)) throw new ConfigError(`SUBTITLE_MCP_LOG_LEVEL: expected error|warn|info|debug, got '${logLevel}'`);

  const http = httpArg ? parseHostPort(httpArg) : undefined;
  if (hosted && !http) throw new ConfigError("SUBTITLE_MCP_HOSTED needs --http");
  const mode: Mode = hosted ? "hosted" : http ? "sidecar" : "local";

  const allowedDirs = cliAllow.length ? cliAllow : parseDirList(env.SUBTITLE_MCP_ALLOWED_DIRS);
  const readonlyDirs = cliRo.length ? cliRo : parseDirList(env.SUBTITLE_MCP_READONLY_DIRS);
  if (hosted && (allowedDirs.length || readonlyDirs.length)) throw new ConfigError("hosted mode: path settings (SUBTITLE_MCP_ALLOWED_DIRS / READONLY_DIRS) are not allowed");

  if (env.SUBTITLE_API_KEY && env.SUBTITLE_API_KEY_FILE) throw new ConfigError("set either SUBTITLE_API_KEY or SUBTITLE_API_KEY_FILE, not both");
  if (env.SUBTITLE_API_KEY_FILE && checkFiles) readSecretFile(env.SUBTITLE_API_KEY_FILE, "SUBTITLE_API_KEY_FILE");

  const httpTokens = list(env.SUBTITLE_MCP_HTTP_TOKEN);
  const httpTokenFile = env.SUBTITLE_MCP_HTTP_TOKEN_FILE || undefined;
  if (mode === "sidecar") {
    const fileTokens = httpTokenFile && checkFiles ? readSecretFile(httpTokenFile, "SUBTITLE_MCP_HTTP_TOKEN_FILE") : [];
    const all = [...httpTokens, ...fileTokens];
    if (all.length === 0 && !(httpTokenFile && !checkFiles)) {
      throw new ConfigError("HTTP mode needs an inbound access token: set SUBTITLE_MCP_HTTP_TOKEN or SUBTITLE_MCP_HTTP_TOKEN_FILE (generate one with `openssl rand -hex 32`)");
    }
    if (all.some((t) => t.length < 32)) throw new ConfigError("SUBTITLE_MCP_HTTP_TOKEN: every token must be at least 32 characters (invalid token configured)");
  }
  if (mode === "hosted") {
    throw new ConfigError("hosted mode needs a hosted auth provider (OAuth), which v1 does not ship; run without --hosted");
  }

  const previewMaxBytes = int("SUBTITLE_MCP_PREVIEW_MAX_BYTES", env.SUBTITLE_MCP_PREVIEW_MAX_BYTES, 262_144, PREVIEW_MIN_BYTES)!;
  if (previewMaxBytes > PREVIEW_HARD_CEILING_BYTES) throw new ConfigError(`SUBTITLE_MCP_PREVIEW_MAX_BYTES: must be at most ${PREVIEW_HARD_CEILING_BYTES} (hard ceiling), got ${previewMaxBytes}`);
  const previewDefaultBytes = int("SUBTITLE_MCP_PREVIEW_DEFAULT_BYTES", env.SUBTITLE_MCP_PREVIEW_DEFAULT_BYTES, Math.min(65_536, previewMaxBytes), PREVIEW_MIN_BYTES)!;
  if (previewDefaultBytes > previewMaxBytes) throw new ConfigError(`SUBTITLE_MCP_PREVIEW_DEFAULT_BYTES (${previewDefaultBytes}) must not exceed SUBTITLE_MCP_PREVIEW_MAX_BYTES (${previewMaxBytes})`);

  const allowedHosts = env.SUBTITLE_MCP_ALLOWED_HOSTS ? list(env.SUBTITLE_MCP_ALLOWED_HOSTS) : ["localhost", "127.0.0.1", "[::1]"];
  if (http && !["0.0.0.0", "::", ""].includes(http.host) && !allowedHosts.includes(http.host)) allowedHosts.push(http.host.includes(":") ? `[${http.host}]` : http.host);

  const cfg: Config = {
    mode,
    apiUrl: apiUrl.replace(/\/+$/, ""),
    apiKey: env.SUBTITLE_API_KEY || undefined,
    apiKeyFile: env.SUBTITLE_API_KEY_FILE || undefined,
    httpTokens,
    httpTokenFile,
    http,
    allowedDirs,
    readonlyDirs,
    useClientRoots: bool("SUBTITLE_MCP_USE_CLIENT_ROOTS", env.SUBTITLE_MCP_USE_CLIENT_ROOTS, true),
    partialMaxAgeMs: int("SUBTITLE_MCP_PARTIAL_MAX_AGE_MS", env.SUBTITLE_MCP_PARTIAL_MAX_AGE_MS, 3_600_000, 1)!,
    maxBytes: int("SUBTITLE_MCP_MAX_BYTES", env.SUBTITLE_MCP_MAX_BYTES, undefined, 1),
    timeoutMs: int("SUBTITLE_MCP_TIMEOUT_MS", env.SUBTITLE_MCP_TIMEOUT_MS, 120_000, 1)!,
    retryMaxAttempts: int("SUBTITLE_MCP_RETRY_MAX_ATTEMPTS", env.SUBTITLE_MCP_RETRY_MAX_ATTEMPTS, 3)!,
    retryMaxWaitMs: int("SUBTITLE_MCP_RETRY_MAX_WAIT_MS", env.SUBTITLE_MCP_RETRY_MAX_WAIT_MS, 60_000)!,
    retryBudgetMs: int("SUBTITLE_MCP_RETRY_BUDGET_MS", env.SUBTITLE_MCP_RETRY_BUDGET_MS, 90_000)!,
    previewDefaultBytes,
    previewMaxBytes,
    jsonMaxDecodedBytes: int("SUBTITLE_MCP_JSON_MAX_DECODED_BYTES", env.SUBTITLE_MCP_JSON_MAX_DECODED_BYTES, undefined, 1),
    limitsTtlMs: int("SUBTITLE_MCP_LIMITS_TTL_MS", env.SUBTITLE_MCP_LIMITS_TTL_MS, 300_000)!,
    includeDebug: bool("SUBTITLE_MCP_INCLUDE_DEBUG", env.SUBTITLE_MCP_INCLUDE_DEBUG, false),
    allowedOrigins: list(env.SUBTITLE_MCP_ALLOWED_ORIGINS),
    allowedHosts,
    logLevel: logLevel as LogLevel,
    logPaths: bool("SUBTITLE_MCP_LOG_PATHS", env.SUBTITLE_MCP_LOG_PATHS, false),
  };
  return { kind: "config", config: cfg };
}

/** URL with userinfo stripped, for logs. */
export function safeUrl(u: string): string {
  try {
    const x = new URL(u);
    x.username = "";
    x.password = "";
    return x.toString().replace(/\/$/, "");
  } catch {
    return "[invalid url]";
  }
}

/** Test/embedding helper: a full config with defaults. */
export function defaultConfig(over: Partial<Config> = {}): Config {
  return {
    mode: "local", apiUrl: "http://api.test", httpTokens: [], allowedDirs: [], readonlyDirs: [], useClientRoots: true,
    partialMaxAgeMs: 3_600_000, timeoutMs: 120_000, retryMaxAttempts: 3, retryMaxWaitMs: 60_000,
    retryBudgetMs: 90_000, previewDefaultBytes: 65_536, previewMaxBytes: 262_144,
    limitsTtlMs: 300_000, includeDebug: false, allowedOrigins: [], allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
    logLevel: "error", logPaths: false, ...over,
  };
}
