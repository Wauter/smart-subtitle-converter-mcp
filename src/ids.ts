import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 26-char ULID (48-bit ms timestamp + 80 random bits), Crockford base32. */
export function ulid(now = Date.now()): string {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let r = "";
  for (let i = 0; i < 16; i++) r += CROCKFORD[rnd[i] % 32];
  return time + r;
}

export const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** One id per tool call: `mcp-<ULID>` (30 chars). */
export function newCallId(): string {
  return "mcp-" + ulid();
}

/** Appends a suffix (".c2", ".r1", ...) keeping the total within 64 characters. */
export function withSuffix(base: string, suffix: string): string {
  const s = suffix.slice(0, 32);
  const room = 64 - s.length;
  return base.slice(0, room) + s;
}
