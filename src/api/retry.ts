/** Retry-After: delta-seconds or HTTP-date. Returns seconds (>= 0) or undefined. */
export function parseRetryAfter(v: string | null | undefined, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const d = Date.parse(t);
  if (Number.isNaN(d)) return undefined;
  return Math.max(0, Math.ceil((d - now) / 1000));
}

/** Wait for a known Retry-After: exactly that long plus 0–20% jitter (never earlier). */
export function retryAfterWaitMs(seconds: number, rnd = Math.random): number {
  return Math.round(seconds * 1000 * (1 + 0.2 * rnd()));
}

/** Exponential backoff 1 s, 2 s, 4 s, … with ±20% jitter. `retry` is 1-based. */
export function backoffMs(retry: number, rnd = Math.random): number {
  const base = 1000 * 2 ** (retry - 1);
  return Math.round(base * (0.8 + 0.4 * rnd()));
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
