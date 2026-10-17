import type { Config } from "./config.js";
import type { Logger } from "./log.js";
import { apiInfo, EXPECTED_API_VERSION, mismatchMessage, versionCompatible } from "./api/info.js";

/**
 * GET /healthz (unauthenticated) → logs the API version and checks it against the target (§10, D-37/D-43:
 * same major.minor). A mismatch only warns; nothing blocks startup and no behaviour changes (D-36).
 */
export function probeApi(cfg: Pick<Config, "apiUrl">, log: Logger, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<void> {
  if (apiInfo.inflight) return apiInfo.inflight;
  apiInfo.inflight = (async () => {
    try {
      const res = await fetchImpl(cfg.apiUrl + "/healthz", { redirect: "error", signal: AbortSignal.timeout(5000) });
      const j: any = await res.json().catch(() => ({}));
      apiInfo.version = typeof j.version === "string" ? j.version : undefined;
      apiInfo.libse = typeof j.libse === "string" ? j.libse : undefined;
      apiInfo.probedAt = Date.now();
      apiInfo.versionMismatch = !versionCompatible(apiInfo.version);
      log.info("api", { "api.version": apiInfo.version, libse: apiInfo.libse, status: res.status, expectedApiVersion: EXPECTED_API_VERSION });
      if (apiInfo.versionMismatch) log.warn(mismatchMessage(), { "api.version": apiInfo.version, expectedApiVersion: EXPECTED_API_VERSION });
    } catch (e) {
      log.warn("API not reachable yet; will retry on the first tool call", { error: (e as Error).message });
    } finally {
      apiInfo.inflight = undefined;
    }
  })();
  return apiInfo.inflight;
}

/** D-36 feature sanity check: warns once (as a version mismatch) and changes no behaviour. */
export function featureMismatch(log: Logger, what: string): void {
  if (apiInfo.featureMismatch) return;
  apiInfo.featureMismatch = what;
  log.warn(`API doesn't look like the target version (${what}); this MCP targets ${EXPECTED_API_VERSION}; use the matching release pair.`, { "api.version": apiInfo.version, expectedApiVersion: EXPECTED_API_VERSION });
}
