import { mcpError, type ToolFailure } from "../errors.js";

/** §8.3 local write-failure classes [D-35]. */
export type WriteFailureCode =
  | "disk-full" | "permission-denied" | "read-only-filesystem" | "output-locked" | "path-too-long"
  | "staging-unavailable" | "cross-device" | "io-error" | "write-failed";

export const WRITE_FAILURE_CODES = new Set<string>([
  "disk-full", "permission-denied", "read-only-filesystem", "output-locked", "path-too-long",
  "staging-unavailable", "cross-device", "io-error", "write-failed",
]);

/** Filesystem policy failures. */
export const WRITE_STOP_CODES = new Set<string>([
  ...WRITE_FAILURE_CODES, "output-exists", "source-overwrite-refused",
]);

export const WRITE_HINTS: Record<WriteFailureCode, string> = {
  "disk-full": "Free space (or raise the quota) on the output volume, or choose another output folder.",
  "permission-denied": "The MCP's user (sidecar: the container user) can't write here; fix the folder permissions or choose another folder.",
  "read-only-filesystem": "The output volume is mounted read-only; remount it read-write or choose another folder.",
  "output-locked": "Another program has the file open; close it and retry. The old file is kept.",
  "path-too-long": "Use a shorter output folder or file name.",
  "staging-unavailable": "Make `<root>/.subtitle-mcp-staging` writable for the MCP (sidecar: the container user), or choose another output root.",
  "cross-device": "The destination is on a different mount than its output root; configure that mount as its own output root.",
  "io-error": "Check the disk or network share connection, then retry.",
  "write-failed": "Unexpected write error; see osError.",
};

const OS_TEXT: Record<string, string> = {
  ENOSPC: "no space left on device",
  EDQUOT: "disk quota exceeded",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  EROFS: "read-only file system",
  EBUSY: "resource busy or locked",
  ETXTBSY: "file busy",
  ENAMETOOLONG: "name too long",
  EXDEV: "cross-device link",
  EIO: "input/output error",
  ENOTCONN: "not connected",
  ESTALE: "stale file handle",
  ETIMEDOUT: "timed out",
  EHOSTDOWN: "host is down",
};

export interface ClassifyContext {
  /** The operation touches an existing target (replace): EPERM/EACCES may be a sharing violation. */
  existingTarget?: boolean;
  platform?: NodeJS.Platform;
}

/** Classifies an errno into a §8.3 code. */
export function classifyErrno(code: string | undefined, ctx: ClassifyContext = {}): WriteFailureCode {
  const platform = ctx.platform ?? process.platform;
  switch (code) {
    case "ENOSPC":
    case "EDQUOT":
      return "disk-full";
    case "EBUSY":
    case "ETXTBSY":
      return "output-locked";
    case "EACCES":
    case "EPERM":
      return ctx.existingTarget && platform === "win32" ? "output-locked" : "permission-denied";
    case "EROFS":
      return "read-only-filesystem";
    case "ENAMETOOLONG":
      return "path-too-long";
    case "EXDEV":
      return "cross-device";
    case "EIO":
    case "ENOTCONN":
    case "ESTALE":
    case "ETIMEDOUT":
    case "EHOSTDOWN":
      return "io-error";
    default:
      return "write-failed";
  }
}

export function osErrorOf(e: unknown): { code: string; syscall?: string; message: string } {
  const err = e as NodeJS.ErrnoException;
  const code = err?.code ?? "UNKNOWN";
  return { code, ...(err?.syscall ? { syscall: err.syscall } : {}), message: OS_TEXT[code] ?? (err?.message ? String(err.message).replace(/,.*$/, "") : "unknown error") };
}

/** Builds the classified ToolFailure: "Couldn't write <path>: <os text> (<CODE>, <syscall>)". */
export function writeFailure(e: unknown, callerPath: string, ctx: ClassifyContext & { verb?: string; forceCode?: WriteFailureCode } = {}): ToolFailure {
  const os = osErrorOf(e);
  const code = ctx.forceCode ?? classifyErrno(os.code, ctx);
  const verb = ctx.verb ?? "write";
  const detail = `Couldn't ${verb} ${callerPath}: ${os.message} (${os.code}${os.syscall ? `, ${os.syscall}` : ""}).`;
  return mcpError(code, detail, WRITE_HINTS[code], { path: callerPath, osError: os });
}
