import type { Config } from "../config.js";
import type { UpstreamAuth } from "../auth.js";
import { mapProblem, mcpError, timeoutPhase, ToolFailure, type Mode, type ToolError } from "../errors.js";
import { withSuffix } from "../ids.js";
import type { Logger } from "../log.js";
import { abortableSleep, backoffMs, parseRetryAfter, retryAfterWaitMs } from "./retry.js";

export interface CallStats {
  attempts: number;
  retryWaitMs: number;
  requestIds: string[];
  bytesOut: number;
  bytesIn: number;
}
export const newStats = (): CallStats => ({ attempts: 0, retryWaitMs: 0, requestIds: [], bytesOut: 0, bytesIn: 0 });

export interface CallCtx {
  /** Base request id for this call or chunk (`mcp-<ULID>[.c<k>]`). */
  requestId: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void | Promise<void>;
  stats: CallStats;
}

export interface ApiRequest {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | undefined>;
  json?: unknown;
  raw?: { body: Buffer | string; contentType: string };
  kind: "metadata" | "conversion";
  /** Statuses returned to the caller instead of being mapped to an error (e.g. 404 for /v1/limits). */
  passStatuses?: number[];
  accept?: string;
  responseBytes?: boolean;
  headers?: Record<string, string>;
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  json?: unknown;
  bytes?: Buffer;
  requestId?: string;
  contentType: string;
}

const RETRY_NET_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "ECONNABORTED"]);

function netCode(err: unknown): string | undefined {
  let e: any = err;
  for (let i = 0; i < 4 && e; i++) {
    if (typeof e.code === "string") return e.code;
    e = e.cause;
  }
  return undefined;
}

export class ApiClient {
  readonly authHeader: () => string | undefined;
  constructor(
    private readonly cfg: Pick<Config, "apiUrl" | "timeoutMs" | "retryMaxAttempts" | "retryMaxWaitMs" | "retryBudgetMs" | "includeDebug">,
    auth: UpstreamAuth,
    private readonly mode: Mode,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly rnd: () => number = Math.random,
  ) {
    this.authHeader = () => auth.headerFor({});
  }

  url(p: string, query?: Record<string, string | undefined>): string {
    const u = new URL(this.cfg.apiUrl + p);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  }

  async request(req: ApiRequest, ctx: CallCtx): Promise<ApiResponse> {
    const timeoutMs = req.kind === "metadata" ? Math.min(this.cfg.timeoutMs, 15_000) : this.cfg.timeoutMs;
    const body: RequestInit["body"] = req.json !== undefined ? JSON.stringify(req.json) : req.raw ? (req.raw.body as any) : undefined;
    const bodyLen = typeof body === "string" ? Buffer.byteLength(body) : Buffer.isBuffer(body) ? body.length : 0;
    const url = this.url(req.path, req.query);
    let retries = 0;
    let waited = 0;
    for (;;) {
      if (ctx.signal?.aborted) throw mcpError("cancelled", "The client cancelled the request.", undefined, { attempts: ctx.stats.attempts });
      const rid = retries === 0 ? ctx.requestId : withSuffix(ctx.requestId, `.r${retries}`);
      ctx.stats.requestIds.push(rid);
      ctx.stats.attempts++;
      const headers: Record<string, string> = { ...req.headers, Accept: req.accept ?? "application/json", "X-Request-Id": rid };
      if (req.json !== undefined) headers["Content-Type"] = "application/json";
      else if (req.raw) headers["Content-Type"] = req.raw.contentType;
      const auth = this.authHeader();
      if (auth) headers.Authorization = auth;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;

      let res: Response;
      try {
        res = await this.fetchImpl(url, { method: req.method, headers, body, redirect: "error", signal });
        ctx.stats.bytesOut += bodyLen;
      } catch (err) {
        if (ctx.signal?.aborted) throw mcpError("cancelled", "The client cancelled the request.", undefined, { attempts: ctx.stats.attempts, requestId: rid });
        if (timeoutSignal.aborted)
          throw mcpError("mcp-timeout", `No answer from the API within ${timeoutMs} ms.`, "The converter may be overloaded; retry later.", { attempts: ctx.stats.attempts, requestId: rid });
        const code = netCode(err);
        const te: ToolError = {
          source: "mcp",
          code: "api-unreachable",
          detail: `Cannot reach the API (${code ?? (err as Error)?.message ?? "network error"}).`,
          hint: req.method === "POST" && req.path === "/v1/convert/json" ? "The conversion may already have been accepted. Inspect the destination or known job before resubmitting; this POST was not replayed." : "Check SUBTITLE_API_URL and that the API is running.",
          requestId: rid,
          attempts: ctx.stats.attempts,
        };
        if (code && RETRY_NET_CODES.has(code) && !(req.method === "POST" && req.path === "/v1/convert/json")) {
          const w = await this.planWait(retries, waited, undefined);
          if (w !== undefined) {
            await this.doWait(w, ctx, `API unreachable (${code}); retrying in ${Math.ceil(w / 1000)}s (attempt ${retries + 2}/${this.cfg.retryMaxAttempts + 1})`);
            waited += w;
            retries++;
            continue;
          }
        }
        throw new ToolFailure(te);
      }

      const contentType = res.headers.get("content-type") ?? "";
      const echoed = res.headers.get("x-request-id") ?? undefined;
      let buf: Buffer;
      try {
        buf = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        if (ctx.signal?.aborted) throw mcpError("cancelled", "The client cancelled the request.", undefined, { attempts: ctx.stats.attempts, requestId: echoed ?? rid });
        if (timeoutSignal.aborted) throw mcpError("mcp-timeout", `No answer from the API within ${timeoutMs} ms.`, "The converter may be overloaded; retry later.", { attempts: ctx.stats.attempts, requestId: echoed ?? rid });
        throw mcpError("api-unreachable", `Connection lost while reading the response (${netCode(err) ?? "error"}).`, undefined, { requestId: echoed ?? rid, attempts: ctx.stats.attempts });
      }
      ctx.stats.bytesIn += buf.length;
      const isJson = /json/i.test(contentType);
      let parsed: unknown;
      if (isJson && buf.length) {
        try {
          parsed = JSON.parse(buf.toString("utf8"));
        } catch {
          parsed = undefined;
        }
      }

      if ((res.status >= 200 && res.status < 300) || req.passStatuses?.includes(res.status)) {
        if (res.status >= 200 && res.status < 300 && (req.accept ?? "application/json") === "application/json") {
          if (!isJson || parsed === undefined)
            throw mcpError("api-protocol-error", `Unexpected ${contentType || "empty"} response from ${req.path}.`, "Check SUBTITLE_API_URL and the API version.", { requestId: echoed ?? rid, status: res.status });
        }
        const requestId = (parsed && typeof parsed === "object" && typeof (parsed as any).requestId === "string" ? (parsed as any).requestId : undefined) ?? echoed;
        return { status: res.status, headers: res.headers, json: parsed, bytes: req.responseBytes || !isJson ? buf : undefined, requestId, contentType };
      }

      const te = mapProblem(res.status, isJson ? parsed : undefined, {
        mode: this.mode,
        includeDebug: this.cfg.includeDebug,
        endpoint: req.path,
        headerRequestId: echoed ?? rid,
      });
      te.attempts = ctx.stats.attempts;
      if (req.method === "POST" && req.path.startsWith("/v1/convert")) te.hint = `${te.hint ?? ""} This conversion POST was not replayed; inspect any known job or destination before resubmitting.`.trim();
      const retryable = !(req.method === "POST" && req.path.startsWith("/v1/convert")) && (res.status === 429 || res.status === 503 || (res.status === 504 && timeoutPhase(parsed) === "queue"));
      if (retryable) {
        const ra = parseRetryAfter(res.headers.get("retry-after"));
        if (ra !== undefined) te.retryAfterSeconds = ra;
        const w = await this.planWait(retries, waited, ra);
        if (w !== undefined) {
          const what = res.status === 429 ? "API rate limited" : res.status === 503 ? "Converter busy (queue full)" : "Converter overloaded (queue timeout)";
          await this.doWait(w, ctx, `${what}; retrying in ${Math.ceil(w / 1000)}s (attempt ${retries + 2}/${this.cfg.retryMaxAttempts + 1})`);
          waited += w;
          retries++;
          continue;
        }
      }
      throw new ToolFailure(te);
    }
  }

  /** Returns the wait in ms, or undefined when the retry budget or max wait forbids another attempt. */
  private async planWait(retriesSoFar: number, waited: number, retryAfterSec: number | undefined): Promise<number | undefined> {
    if (retriesSoFar >= this.cfg.retryMaxAttempts) return undefined;
    const remaining = this.cfg.retryBudgetMs - waited;
    if (retryAfterSec !== undefined) {
      const minMs = retryAfterSec * 1000;
      if (minMs > this.cfg.retryMaxWaitMs || minMs > remaining) return undefined;
      return Math.min(retryAfterWaitMs(retryAfterSec, this.rnd), Math.max(minMs, remaining));
    }
    const w = backoffMs(retriesSoFar + 1, this.rnd);
    if (w > remaining || w > this.cfg.retryMaxWaitMs) return undefined;
    return w;
  }

  private async doWait(ms: number, ctx: CallCtx, message: string): Promise<void> {
    this.log.debug("retry-wait", { ms, requestId: ctx.requestId });
    try {
      await ctx.onProgress?.(message);
    } catch {
      /* progress is best effort */
    }
    try {
      await abortableSleep(ms, ctx.signal);
    } catch {
      throw mcpError("cancelled", "The client cancelled the request.", undefined, { attempts: ctx.stats.attempts });
    }
    ctx.stats.retryWaitMs += ms;
  }
}
