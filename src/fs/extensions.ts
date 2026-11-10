import nodePath from "node:path";
import { mcpError, ToolFailure } from "../errors.js";
import type { ApiClient, CallCtx } from "../api/client.js";
import { newStats } from "../api/client.js";
import type { LimitsCache } from "../api/limits.js";
import type { Logger } from "../log.js";
import { withSuffix } from "../ids.js";

/**
 * H3: only subtitle files are listed, read or written in this server's local folders. The allowed extensions come from
 * the converter API (GET /v1/limits `storage.extensions`, derived from libse and cached with the other limits); when the
 * API doesn't report them (older API, unreachable, 401), this built-in copy of the same list is used, so the rule always
 * applies. The list is never shown to the model or put in tool descriptions; a refusal is one short line.
 */
export const BUILTIN_EXTENSIONS: readonly string[] = [
  ".890", ".aqt", ".asc", ".ass", ".ats", ".aya", ".bcc", ".c", ".cac", ".cap", ".caption", ".chk", ".cin", ".cip", ".cmft", ".crk", ".csv",
  ".ctm", ".dat", ".detx", ".dfxp", ".dtc", ".dv", ".edl", ".elr", ".eztxml", ".fcpxml", ".flc", ".fpc", ".gst", ".html", ".imscr", ".imtpro",
  ".inqscr", ".ismt", ".itt", ".json", ".jss", ".lrc", ".mcc", ".mvt", ".pac", ".pjs", ".pns", ".psl", ".pst", ".rt", ".rtf", ".sbv", ".scc",
  ".sif", ".smi", ".spt", ".sptx", ".srt", ".ssa", ".stl", ".stp", ".sub", ".subtitle", ".tek", ".titl", ".tmm", ".tmx", ".trs", ".tsv", ".tt",
  ".ttml", ".tts", ".ttxt", ".txt", ".uld", ".ult", ".usf", ".utx", ".vid", ".vtt", ".w32", ".webvtt", ".wsrt", ".xif", ".xml", ".xmp",
  ".xsubtitle", ".zeg",
];

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
  private builtin = new Set(BUILTIN_EXTENSIONS);
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

  /** The allowed set: the API's (cached with limits), else the built-in copy. */
  async allowed(call?: CallCtx): Promise<Set<string>> {
    const st = await this.limits.get(this.ctx(call)).catch((e) => {
      if (e instanceof ToolFailure && e.toolError.code === "cancelled") throw e;
      return undefined;
    });
    return (st?.kind === "ok" ? cleanList((st.limits.raw as any)?.storage?.extensions) : undefined) ?? this.builtin;
  }

  /** Throws extension-not-allowed (one short line) when the file name doesn't have a subtitle extension. */
  async check(name: string, purpose: Purpose, call?: CallCtx): Promise<void> {
    const ext = extOf(name);
    if (ext && (await this.allowed(call)).has(ext)) return;
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
