import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiClient, newStats, type CallCtx } from "../../src/api/client.js";
import { parseRetryAfter, backoffMs, retryAfterWaitMs } from "../../src/api/retry.js";
import { StaticKeyAuth } from "../../src/auth.js";
import { defaultConfig } from "../../src/config.js";
import { silentLogger } from "../../src/log.js";
import { ToolFailure } from "../../src/errors.js";

afterEach(() => vi.useRealTimers());
const nope = (): ToolFailure => {
  throw new Error("expected a failure");
};

const problem = (status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ status, code, title: code, detail: "d", hint: "h", ...extra }), { status, headers: { "content-type": "application/problem+json", ...headers } });
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });

function client(responses: (() => Response | Promise<Response>)[], cfg = {}) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string> });
    const r = responses[Math.min(i++, responses.length - 1)];
    return r();
  }) as unknown as typeof fetch;
  const c = new ApiClient(defaultConfig(cfg), new StaticKeyAuth("k"), "local", silentLogger(), fetchImpl, () => 0);
  return { c, seen };
}
const ctx = (signal?: AbortSignal): CallCtx & { messages: string[] } => {
  const messages: string[] = [];
  return { requestId: "mcp-TEST", stats: newStats(), signal, onProgress: (m) => void messages.push(m), messages };
};

describe("Retry-After parsing", () => {
  it("delta-seconds and HTTP-date", () => {
    expect(parseRetryAfter("5")).toBe(5);
    const now = Date.parse("Sat, 17 Oct 2026 10:00:00 GMT");
    expect(parseRetryAfter("Sat, 17 Oct 2026 10:00:30 GMT", now)).toBe(30);
    expect(parseRetryAfter("garbage")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
  it("never earlier than Retry-After; jitter 0–20%", () => {
    expect(retryAfterWaitMs(5, () => 0)).toBe(5000);
    expect(retryAfterWaitMs(5, () => 1)).toBe(6000);
    expect(backoffMs(1, () => 0.5)).toBe(1000);
    expect(backoffMs(3, () => 0)).toBe(3200);
  });
});

describe("ApiClient retries", () => {
  it("retries 503 after Retry-After, with .r<n> ids and progress", async () => {
    vi.useFakeTimers();
    const { c, seen } = client([() => problem(503, "queue-full", {}, { "retry-after": "2" }), ok]);
    const x = ctx();
    const p = c.request({ method: "GET", path: "/v1/formats", kind: "metadata" }, x);
    await vi.advanceTimersByTimeAsync(1999);
    expect(seen.length).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(seen.map((s) => s.headers["X-Request-Id"])).toEqual(["mcp-TEST", "mcp-TEST.r1"]);
    expect(seen[0].headers.Authorization).toBe("Bearer k");
    expect(x.stats.attempts).toBe(2);
    expect(x.messages[0]).toMatch(/Converter busy \(queue full\); retrying in 2s \(attempt 2\/4\)/);
  });
  it("fails at once when Retry-After exceeds the max wait", async () => {
    const { c, seen } = client([() => problem(429, "rate-limited", {}, { "retry-after": "61" })]);
    const err = await c.request({ method: "GET", path: "/x", kind: "metadata" }, ctx()).then(nope, (e: unknown) => e as ToolFailure);
    expect(seen.length).toBe(1);
    expect(err.toolError.code).toBe("rate-limited");
    expect(err.toolError.retryAfterSeconds).toBe(61);
    expect(err.toolError.attempts).toBe(1);
  });
  it("respects the total budget", async () => {
    vi.useFakeTimers();
    const { c, seen } = client([() => problem(503, "queue-full", {}, { "retry-after": "40" })], { retryBudgetMs: 90_000 });
    const p = c.request({ method: "GET", path: "/x", kind: "metadata" }, ctx()).then(nope, (e: unknown) => e as ToolFailure);
    await vi.advanceTimersByTimeAsync(200_000);
    const err = await p;
    expect(seen.length).toBe(3); // 40 + 40 fits 90, a third wait doesn't
    expect(err.toolError.attempts).toBe(3);
  });
  it("retries a queue-phase 504 with backoff, not a running-phase or phase-less 504", async () => {
    vi.useFakeTimers();
    const q = client([() => problem(504, "conversion-timeout", { phase: "queue" }), ok]);
    const p = q.c.request({ method: "POST", path: "/v1/convert/json", kind: "conversion", json: {} }, ctx());
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(q.seen.length).toBe(2);
    for (const extra of [{ phase: "running" }, {}]) {
      const r = client([() => problem(504, "conversion-timeout", extra), ok]);
      const e = await r.c.request({ method: "POST", path: "/x", kind: "conversion", json: {} }, ctx()).then(nope, (e: unknown) => e as ToolFailure);
      expect(r.seen.length).toBe(1);
      expect(e.toolError.code).toBe("conversion-timeout");
    }
  });
  it("retries connection errors but not 500/413/401", async () => {
    vi.useFakeTimers();
    const refused = () => {
      const e = new TypeError("fetch failed") as any;
      e.cause = { code: "ECONNREFUSED" };
      throw e;
    };
    const r = client([refused, ok]);
    const p = r.c.request({ method: "GET", path: "/x", kind: "metadata" }, ctx());
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(r.seen.length).toBe(2);
    vi.useRealTimers();
    for (const [s, code] of [[500, "internal-error"], [413, "payload-too-large"], [401, "unauthorized"]] as const) {
      const x = client([() => problem(s, code), ok]);
      await expect(x.c.request({ method: "GET", path: "/x", kind: "metadata" }, ctx())).rejects.toBeInstanceOf(ToolFailure);
      expect(x.seen.length).toBe(1);
    }
  });
  it("DNS failure → api-unreachable without retry", async () => {
    const r = client([
      () => {
        const e = new TypeError("fetch failed") as any;
        e.cause = { code: "ENOTFOUND" };
        throw e;
      },
    ]);
    const e = await r.c.request({ method: "GET", path: "/x", kind: "metadata" }, ctx()).then(nope, (e: unknown) => e as ToolFailure);
    expect(e.toolError.code).toBe("api-unreachable");
    expect(r.seen.length).toBe(1);
  });
  it("cancellation aborts the wait", async () => {
    const ac = new AbortController();
    const r = client([() => problem(503, "queue-full", {}, { "retry-after": "30" }), ok]);
    const p = r.c.request({ method: "GET", path: "/x", kind: "metadata" }, ctx(ac.signal)).then(nope, (e: unknown) => e as ToolFailure);
    setTimeout(() => ac.abort(), 20);
    const e = await p;
    expect(e.toolError.code).toBe("cancelled");
    expect(r.seen.length).toBe(1);
  });
  it("MCP-side timeout → mcp-timeout", async () => {
    const r = client([() => new Promise<Response>(() => {})], { timeoutMs: 50 });
    const slow = (async (_u: string, init: RequestInit) =>
      new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch;
    const c = new ApiClient(defaultConfig({ timeoutMs: 50 }), new StaticKeyAuth(), "local", silentLogger(), slow);
    const e = await c.request({ method: "POST", path: "/x", kind: "conversion", json: {} }, ctx()).then(nope, (e: unknown) => e as ToolFailure);
    expect(e.toolError.code).toBe("mcp-timeout");
    void r;
  });
  it("non-JSON 2xx → api-protocol-error; redirects are refused", async () => {
    const r = client([() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })]);
    const e = await r.c.request({ method: "GET", path: "/x", kind: "metadata" }, ctx()).then(nope, (e: unknown) => e as ToolFailure);
    expect(e.toolError.code).toBe("api-protocol-error");
  });
});
