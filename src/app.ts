import type { Config } from "./config.js";
import type { Deps, Features } from "./context.js";
import { createLogger, type Logger } from "./log.js";
import { ApiClient } from "./api/client.js";
import { LimitsCache } from "./api/limits.js";
import { StaticKeyAuth, type UpstreamAuth } from "./auth.js";
import { CombinedRoots, ClientRoots, PathGuard, StaticRoots, type Root, type RootsProvider } from "./fs/guard.js";
import { allowedFoldersText } from "./fs/folders.js";
import { realFsOps, SafeWriter, type FsOps } from "./fs/write.js";
import { VERSION } from "./version.js";

export interface DepsOptions {
  log?: Logger;
  /** Configured roots, realpath'd. */
  roots?: Root[];
  /** Overrides the roots provider (client roots in local mode). */
  rootsProvider?: RootsProvider;
  fetchImpl?: typeof fetch;
  auth?: UpstreamAuth;
  fsOps?: FsOps;
  clock?: () => Date;
  features?: Features;
  limits?: LimitsCache;
  rnd?: () => number;
}

export function buildDeps(cfg: Config, o: DepsOptions = {}): Deps {
  const log = o.log ?? createLogger(cfg.logLevel, cfg.logPaths);
  const auth = o.auth ?? new StaticKeyAuth(cfg.apiKey, cfg.apiKeyFile, log);
  const api = new ApiClient(cfg, auth, cfg.mode, log, o.fetchImpl, o.rnd);
  const roots = o.roots ?? [];
  const configured = roots.length > 0;
  const provider = cfg.mode === "hosted" ? new StaticRoots([], "hosted mode has no file access") : (o.rootsProvider ?? new StaticRoots(roots, cfg.mode === "sidecar" ? "no folders are mounted and allowlisted (SUBTITLE_MCP_ALLOWED_DIRS)" : "no allowed folders are configured and the client provided no roots"));
  const pathsInSchema = cfg.mode === "local" || (cfg.mode === "sidecar" && configured);
  const anyWritable = roots.some((r) => r.writable);
  const dynamicRoots = provider instanceof ClientRoots || provider instanceof CombinedRoots;
  // Local: client roots (read-write) may still arrive, so writes are possible unless only fixed read-only roots exist.
  const writable = cfg.mode === "local" ? (configured && !dynamicRoots ? anyWritable : true) : cfg.mode === "sidecar" && anyWritable;
  const guard = new PathGuard(provider);
  const writer = new SafeWriter(log, o.fsOps, o.clock);
  writer.rootOf = (dir) => guard.outputRoot(dir);
  return {
    cfg,
    log,
    api,
    limits: o.limits ?? new LimitsCache(api, cfg, log),
    guard,
    writer,
    fsOps: o.fsOps ?? realFsOps,
    features: o.features ?? {},
    pathsInSchema,
    writable,
    get rootsText() {
      return allowedFoldersText(provider.snapshot());
    },
    dynamicRoots,
    version: VERSION,
  };
}
