import fs from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Logger } from "./log.js";

/** Upstream auth (§11.4). v1 has only StaticKeyAuth; it never looks at incoming headers ([D-31]). */
export interface UpstreamAuth {
  headerFor(ctx: { incomingHeaders?: IncomingHttpHeaders }): string | undefined;
}

function firstKeyLine(text: string): string | undefined {
  return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
}

/** Watches a file by mtime; on read failure keeps the last good value and warns. */
class MtimeFile<T> {
  private mtimeMs = -1;
  private value: T;
  constructor(private readonly file: string, private readonly parse: (text: string) => T | undefined, initial: T, private readonly log?: Logger, private readonly what = "file") {
    this.value = initial;
    this.reload(true);
  }
  get(): T {
    this.reload(false);
    return this.value;
  }
  private reload(initial: boolean) {
    try {
      const st = fs.statSync(this.file);
      if (st.mtimeMs === this.mtimeMs) return;
      const parsed = this.parse(fs.readFileSync(this.file, "utf8"));
      if (parsed === undefined) throw new Error("empty");
      this.value = parsed;
      this.mtimeMs = st.mtimeMs;
      if (!initial) this.log?.info(`${this.what} reloaded`);
    } catch {
      if (this.mtimeMs !== -2) this.log?.warn(`${this.what} unreadable or empty; keeping the last good value`);
      this.mtimeMs = -2;
    }
  }
}

export class StaticKeyAuth implements UpstreamAuth {
  private readonly file?: MtimeFile<string | undefined>;
  constructor(private readonly key?: string, keyFile?: string, log?: Logger) {
    if (keyFile) this.file = new MtimeFile(keyFile, firstKeyLine, undefined, log, "SUBTITLE_API_KEY_FILE");
  }
  headerFor(_ctx: { incomingHeaders?: IncomingHttpHeaders } = {}): string | undefined {
    const k = this.file ? this.file.get() : this.key;
    return k ? `Bearer ${k}` : undefined;
  }
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
export const fingerprint = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);

/** Inbound access tokens for HTTP mode (§11.5): env list ∪ token file (mtime reload). */
export class InboundTokens {
  private readonly file?: MtimeFile<string[]>;
  constructor(private readonly envTokens: string[], tokenFile?: string, log?: Logger) {
    if (tokenFile) {
      this.file = new MtimeFile(
        tokenFile,
        (t) => {
          const lines = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
          if (lines.length === 0 || lines.some((l) => l.length < 32)) return undefined;
          return lines;
        },
        [],
        log,
        "SUBTITLE_MCP_HTTP_TOKEN_FILE",
      );
    }
  }
  tokens(): string[] {
    return [...this.envTokens, ...(this.file ? this.file.get() : [])];
  }
  /** Constant-time check against every configured token. Returns the matching token's fingerprint. */
  check(authorization: string | undefined): { ok: true; fp: string } | { ok: false; reason: "missing" | "invalid" } {
    const m = authorization ? /^Bearer\s+(\S+)\s*$/i.exec(authorization) : null;
    if (!m) return { ok: false, reason: authorization ? "invalid" : "missing" };
    const presented = digest(m[1]);
    let match: string | undefined;
    for (const t of this.tokens()) {
      if (timingSafeEqual(presented, digest(t)) && match === undefined) match = t;
    }
    return match !== undefined ? { ok: true, fp: fingerprint(match) } : { ok: false, reason: "invalid" };
  }
}
