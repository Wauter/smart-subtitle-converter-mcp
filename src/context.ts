import type { Config } from "./config.js";
import type { Logger } from "./log.js";
import type { ApiClient, CallCtx, CallStats } from "./api/client.js";
import type { LimitsCache } from "./api/limits.js";
import type { PathGuard } from "./fs/guard.js";
import type { FsOps, SafeWriter } from "./fs/write.js";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Features {}

export interface Deps {
  cfg: Config;
  log: Logger;
  api: ApiClient;
  limits: LimitsCache;
  guard: PathGuard;
  writer: SafeWriter;
  /** Filesystem ops (injectable in tests); used by the batch stage (D-44). */
  fsOps: FsOps;
  features: Features;
  /** Path parameters are advertised (local; sidecar with configured roots). */
  pathsInSchema: boolean;
  /** convert_batch is registered. */
  batchEnabled: boolean;
  /** A write is possible at all (affects annotations). */
  writable: boolean;
  /** Human description of the allowed folders for descriptions and instructions. */
  rootsText: string;
  version: string;
}

/** Per tool call. */
export interface Call extends CallCtx {
  tool: string;
  stats: CallStats;
  progress: (message: string) => Promise<void>;
  log: Record<string, unknown>;
}
