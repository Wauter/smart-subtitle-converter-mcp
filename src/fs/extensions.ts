import nodePath from "node:path";
import { mcpError, ToolFailure } from "../errors.js";
import type { ApiClient, CallCtx } from "../api/client.js";
import { newStats } from "../api/client.js";
import type { LimitsCache } from "../api/limits.js";
import type { Logger } from "../log.js";
import { withSuffix } from "../ids.js";

/**
 * H3: only subtitle files are listed, read or written in this server's local folders. The allowed extensions always come
 * from the converter API (GET /v1/limits `storage.extensions`, derived from libse and cached with the other limits);
 * there is no built-in copy that could go stale. An older API that doesn't report them: the check is skipped and the
 * tool result carries the mcp-extension-check-skipped warning (allowed folders, hidden-path and no-symlink rules still
 * apply). The list is never shown to the model or put in tool descriptions; a refusal is one short line.
 */

/** Lower-case extension with its dot ("" when there is none; a leading-dot name alone has none). */
export function extOf(name: string): string {
  const base = nodePath.basename(name.replace(/[\\/]+$/, ""));
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
}

const MAX_EXTENSIONS = 2000;
const MAX_FORMATS = 5000;

function cleanList(v: unknown): Set<string> | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = new Set<string>();
  for (const e of v) {
    if (typeof e === "string" && /^\.[a-z0-9_+-]{1,16}$/i.test(e)) out.add(e.toLowerCase());
    if (out.size >= MAX_EXTENSIONS) break;
  }
  return out.size ? out : undefined;
}

export type Purpose = "read" | "listed" | "written";

export class ExtensionPolicy {
  private formats?: { at: number; byId: Map<string, string[]> };
  constructor(
    private readonly limits: LimitsCache,
    private readonly api: ApiClient,
    private readonly ttlMs: number,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  private ctx(call?: CallCtx): CallCtx {
    return { requestId: withSuffix(call?.requestId ?? "mcp", ".e"), signal: call?.signal, stats: newStats() };
  }

  /**
   * The API's allowed set (cached with limits), or undefined when the API doesn't report one (older API): the caller
   * then skips the check and the call is marked so the result carries a warning. When the limits can't be read at all,
   * the real cause (unauthorized, api-unreachable, ...) is raised.
   */
  async allowed(call?: CallCtx): Promise<Set<string> | undefined> {
    let st = await this.limits.get(this.ctx(call));
    if (st.kind === "unknown") {
      // Fetch once more without the cache's error swallowing, so the caller sees why (key, URL, network).
      const res = await this.api.request({ method: "GET", path: "/v1/limits", kind: "metadata", passStatuses: [404] }, this.ctx(call));
      st = res.status === 404 ? { kind: "unsupported" } : { kind: "ok", limits: { raw: res.json } as any };
    }
    const list = st.kind === "ok" ? cleanList((st.limits.raw as any)?.storage?.extensions) : undefined;
    if (!list && call) call.extensionCheckSkipped = true;
    return list;
  }

  /** Throws extension-not-allowed (one short line) when the file name doesn't have a subtitle extension. */
  async check(name: string, purpose: Purpose, call?: CallCtx): Promise<void> {
    const ext = extOf(name);
    const allowed = await this.allowed(call);
    if (!allowed || (ext && allowed.has(ext))) return;
    throw notSubtitle(name, purpose);
  }

  /** Extensions of one format id (Extension + AlternateExtensions from GET /v1/formats, cached), or undefined. */
  async formatExtensions(formatId: string, call?: CallCtx): Promise<string[] | undefined> {
    if (!formatId) return undefined;
    if (!this.formats || this.now() - this.formats.at >= this.ttlMs) {
      try {
        const res = await this.api.request({ method: "GET", path: "/v1/formats", kind: "metadata", query: { kind: "text,binary" } }, this.ctx(call));
        const byId = new Map<string, string[]>();
        for (const f of Array.isArray(res.json) ? (res.json as any[]).slice(0, MAX_FORMATS) : []) {
          if (typeof f?.id !== "string") continue;
          const exts = [f.extension, ...(Array.isArray(f.alternateExtensions) ? f.alternateExtensions : [])].filter((e): e is string => typeof e === "string").map((e) => e.toLowerCase());
          byId.set(f.id, exts);
        }
        this.formats = { at: this.now(), byId };
      } catch (e) {
        if (e instanceof ToolFailure && e.toolError.code === "cancelled") throw e;
        this.log.debug("formats unavailable for the output extension check", { code: e instanceof ToolFailure ? e.toolError.code : "error" });
        return undefined;
      }
    }
    return this.formats.byId.get(formatId);
  }

  /** A local output name must be a subtitle name whose extension belongs to the produced format. */
  async checkOutput(name: string, formatId: string, call?: CallCtx): Promise<void> {
    await this.check(name, "written", call);
    const exts = await this.formatExtensions(formatId, call);
    if (exts?.length && !exts.includes(extOf(name)))
      throw mcpError("extension-not-allowed", `${nodePath.basename(name)} doesn't match the output format; name it with ${exts[0]}.`, undefined, { path: name });
  }
}

export function notSubtitle(name: string, purpose: Purpose): ToolFailure {
  const base = nodePath.basename(name.replace(/[\\/]+$/, "")) || name;
  const verb = purpose === "written" ? "written" : purpose === "listed" ? "listed" : "read";
  return mcpError("extension-not-allowed", `${base} is not a subtitle file, so it isn't ${verb}.`, undefined, { path: name });
}

export const EXTENSION_CHECK_SKIPPED = "mcp-extension-check-skipped";

/** The tool-result warning when the check was skipped (aligned with mcp-api-version-mismatch). */
export function extensionCheckSkippedWarning(apiVersion?: string): { code: string; message: string } {
  return {
    code: EXTENSION_CHECK_SKIPPED,
    message: `Subtitle extension check skipped: the API${apiVersion ? ` (version ${apiVersion})` : ""} doesn't report its subtitle extensions, so file names weren't checked; update the API.`,
  };
}
