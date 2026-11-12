import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import { ToolFailure } from "../errors.js";
import type { Logger } from "../log.js";
import type { ApiClient, CallCtx } from "./client.js";
import { toOptInt } from "./coerce.js";
import { featureMismatch } from "../probe.js";

export interface Limits {
  requestMaxWaitSeconds?: number;
  requestWaitSeconds?: number;
  inputSchemes?: string[];
  outputSchemes?: string[];
  enabledSchemes?: string[];
  maxUploadBytes?: number;
  bodyJson?: number;
  jsonMaxDecoded?: number;
  maxProfileBytes?: number;
  maxCues?: number;
  conversionTimeoutSeconds?: number;
  ebuStlMaxBytes?: number;
  /** storage.list: the API serves /v1/storage/* (STORAGE_LIST_ENABLED). */
  storageList?: boolean;
  /** storage.listSchemes: the schemes it can list (file, s3). */
  listSchemes?: string[];
  raw: unknown;
}

export type LimitsState =
  | { kind: "ok"; limits: Limits }
  | { kind: "unsupported" } // 404: not the target API (D-36: defaults + warning, no fallback mode)
  | { kind: "unknown" }; // 401, network error, bad body

/** The /v1/limits contract shipped in 89ce197 (§4.4). */
export function normalizeLimits(raw: any): Limits {
  const mrb = raw?.maxRequestBodyBytes;
  const bodyJson = typeof mrb === "object" && mrb ? toOptInt(mrb.json) : undefined;
  const schemes = (value: unknown): string[] | undefined => Array.isArray(value) ? value.filter((s: unknown): s is string => typeof s === "string" && ["file", "s3", "https"].includes(s)) : undefined;
  const inputSchemes = schemes(raw?.storage?.inputSchemes), outputSchemes = schemes(raw?.storage?.outputSchemes);
  return {
    requestWaitSeconds: toOptInt(raw?.requestWaitSeconds), inputSchemes, outputSchemes,
    requestMaxWaitSeconds: toOptInt(raw?.requestMaxWaitSeconds),
    enabledSchemes: inputSchemes || outputSchemes ? [...new Set([...(inputSchemes ?? []), ...(outputSchemes ?? [])])] : undefined,
    maxUploadBytes: toOptInt(raw?.maxUploadBytes),
    bodyJson,
    jsonMaxDecoded: toOptInt(raw?.json?.maxDecodedContentBytes),
    maxProfileBytes: toOptInt(raw?.maxProfileBytes),
    maxCues: toOptInt(raw?.maxCues),
    conversionTimeoutSeconds: toOptInt(raw?.conversionTimeoutSeconds),
    ebuStlMaxBytes: toOptInt(raw?.binary?.ebuStlMaxBytes),
    storageList: raw?.storage?.list === true,
    listSchemes: schemes(raw?.storage?.listSchemes)?.filter((s) => s !== "https"),
    raw,
  };
}

export const API_DEFAULT_JSON_BODY = 14_112_088;
export const FALLBACK_JSON_DECODED = 10_485_760;
export const DEFAULT_UPLOAD = 10_485_760;

export interface Caps {
  requestMaxWaitSeconds?: number;
  limitsKnown: boolean;
  jsonDecoded: number;
  jsonBody: number;
  maxUpload?: number;
  maxProfile?: number;
  ebuStlMaxBytes?: number;
  localMax?: number;
}

export function capsFrom(state: LimitsState, cfg: Pick<Config, "jsonMaxDecodedBytes" | "maxBytes">): Caps {
  const l = state.kind === "ok" ? state.limits : undefined;
  return {
    requestMaxWaitSeconds: l?.requestMaxWaitSeconds,
    limitsKnown: !!l,
    jsonDecoded: l?.jsonMaxDecoded ?? cfg.jsonMaxDecodedBytes ?? FALLBACK_JSON_DECODED,
    jsonBody: l?.bodyJson ?? API_DEFAULT_JSON_BODY,
    maxUpload: l?.maxUploadBytes,
    maxProfile: l?.maxProfileBytes,
    ebuStlMaxBytes: l?.ebuStlMaxBytes,
    localMax: cfg.maxBytes,
  };
}

/** Per-process cache keyed by sha256 of the upstream auth header (§9.3). */
export class LimitsCache {
  private entries = new Map<string, { at: number; state: LimitsState }>();
  constructor(
    private readonly api: ApiClient,
    private readonly cfg: Pick<Config, "limitsTtlMs">,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  private key(): string {
    return createHash("sha256").update(this.api.authHeader() ?? "").digest("hex");
  }

  invalidate(): void {
    this.entries.clear();
  }

  async get(ctx: CallCtx): Promise<LimitsState> {
    const k = this.key();
    const hit = this.entries.get(k);
    if (hit && this.now() - hit.at < this.cfg.limitsTtlMs) return hit.state;
    let state: LimitsState;
    try {
      const res = await this.api.request({ method: "GET", path: "/v1/limits", kind: "metadata", passStatuses: [404] }, ctx);
      if (res.status === 404) state = { kind: "unsupported" };
      else state = { kind: "ok", limits: normalizeLimits(res.json) };
    } catch (e) {
      if (!(e instanceof ToolFailure)) throw e;
      if (e.toolError.code === "cancelled") throw e;
      this.log.debug("limits unavailable", { code: e.toolError.code });
      return { kind: "unknown" };
    }
    this.entries.set(k, { at: this.now(), state });
    if (state.kind === "unsupported") featureMismatch(this.log, "GET /v1/limits returned 404; using the documented default limits");
    return state;
  }

  /** Raw limits JSON for the resource; throws when unsupported. */
  peek(): LimitsState | undefined {
    return this.entries.get(this.key())?.state;
  }
}
