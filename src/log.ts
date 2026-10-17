import { createHash } from "node:crypto";
import path from "node:path";

export type LogLevel = "error" | "warn" | "info" | "debug";
const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const SECRET_KEYS = /^(authorization|apikey|api_key|token|password|secret|x-subtitle-api-key|content|profile)$/i;

export interface Logger {
  level: LogLevel;
  logPaths: boolean;
  error(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  /** Path as logged: sha256[:12] + extension unless SUBTITLE_MCP_LOG_PATHS. */
  p(filePath: string): string;
}

/** Structural redaction: secret-looking keys are replaced, nested objects walked. */
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 6 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(val, depth + 1);
  }
  return out;
}

export function hashPath(p: string): string {
  return createHash("sha256").update(p).digest("hex").slice(0, 12) + path.extname(p);
}

/** JSON lines to stderr. stdout is reserved for MCP JSON-RPC in stdio mode. */
export function createLogger(level: LogLevel = "info", logPaths = false, sink: (line: string) => void = (l) => process.stderr.write(l + "\n")): Logger {
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] > ORDER[log.level]) return;
    const rec = { ts: new Date().toISOString(), level: lvl, msg, ...(fields ? (redact(fields) as object) : {}) };
    try {
      sink(JSON.stringify(rec));
    } catch {
      /* never throw from logging */
    }
  };
  const log: Logger = {
    level,
    logPaths,
    error: (m, f) => emit("error", m, f),
    warn: (m, f) => emit("warn", m, f),
    info: (m, f) => emit("info", m, f),
    debug: (m, f) => emit("debug", m, f),
    p: (fp) => (log.logPaths ? fp : hashPath(fp)),
  };
  return log;
}

export const silentLogger = (): Logger => createLogger("error", false, () => {});
