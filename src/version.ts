// Replaced at build time by tsup's define; falls back to package.json in dev/tests.
import { createRequire } from "node:module";

declare const __MCP_VERSION__: string | undefined;

function pkgVersion(): string | undefined {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version?: string }).version;
  } catch {
    return undefined;
  }
}

export const VERSION: string = typeof __MCP_VERSION__ === "string" ? __MCP_VERSION__ : (pkgVersion() ?? "0.0.0-dev");
/** D-43: the MCP and the API share one version number; the expected API version is the MCP's own. */
export const API_TARGET_VERSION: string = VERSION;
