import { API_TARGET_VERSION } from "../version.js";

/** What the background /healthz probe and the feature sanity check learned about the API (process-wide). */
export const apiInfo: {
  version?: string;
  libse?: string;
  probedAt?: number;
  inflight?: Promise<void>;
  /** /healthz reported a version whose major.minor differs from the target (D-43). */
  versionMismatch?: boolean;
  /** Feature sanity check failed (formats without `kind`, /v1/limits 404) — D-36: warns only. */
  featureMismatch?: string;
} = {};

/** D-37/D-43: the API version this MCP release targets (= the MCP's own version). */
export const EXPECTED_API_VERSION = API_TARGET_VERSION;

const parse = (v: string | undefined) => {
  const m = v ? /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
};

/** D-43: compatible = same major.minor as the target version. */
export function versionCompatible(v: string | undefined, expected: string = EXPECTED_API_VERSION): boolean {
  const a = parse(v);
  const b = parse(expected);
  return !!a && !!b && a[0] === b[0] && a[1] === b[1];
}

export function mismatchMessage(): string {
  const mm = EXPECTED_API_VERSION.split(".").slice(0, 2).join(".");
  return `API version ${apiInfo.version ?? "unknown"} is not compatible with this MCP (${mm}.x); use the matching release pair.`;
}

/** The short tool-result warning while a mismatch persists (§10). */
export function mismatchWarning(): { code: string; message: string } | undefined {
  if (apiInfo.versionMismatch) return { code: "mcp-api-version-mismatch", message: mismatchMessage() };
  return undefined;
}
