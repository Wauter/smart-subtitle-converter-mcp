import { z } from "zod";
import nodePath from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Call, Deps } from "../context.js";
import { mcpError, ToolFailure, type ToolError, type WarningT } from "../errors.js";
import { readFileChecked } from "../fs/guard.js";
import { normKey, sanitizeOutputName } from "../fs/write.js";
import { BatchStage } from "../batch/stage.js";
import { withSuffix } from "../ids.js";
import { newStats } from "../api/client.js";
import { ambiguousGroups, selectFromDir, selectFromPaths, stemOf, type SelectedFile } from "../batch/select.js";
import { buildZip, needsAlias } from "../batch/zip.js";
import { chunkItems, type ChunkCaps } from "../batch/chunk.js";
import {
  defineTool, exactlyOne, getCaps, loadProfile, mapVerification, mapWarnings, mutuallyExclusive, tooLarge, Verification, verificationText, Warning, withPartial,
} from "./common.js";
import { MCP_HINTS, timeoutPhase } from "../errors.js";
import { WRITE_FAILURE_CODES } from "../fs/writeErrors.js";

const EntryOut = z.object({
  source: z.string(),
  outputs: z.array(z.string()),
  detected: z.object({ format: z.string(), id: z.string(), encoding: z.string(), kind: z.string().optional(), codePage: z.string().optional() }).nullish(),
  warnings: z.array(Warning),
  /** API 1.2.0: read-back check per binary output, keyed by the written output (as in `outputs`). */
  verification: z.array(Verification.extend({ output: z.string() })).optional(),
});
type EntryOutT = z.infer<typeof EntryOut>;
const Excluded = z.object({ source: z.string(), reason: z.string() });
type ExcludedT = z.infer<typeof Excluded>;
const Failure = z.object({
  source: z.string(),
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
  candidates: z.array(z.string()).optional(),
  requestId: z.string().optional(),
  path: z.string().optional(),
  osError: z.object({ code: z.string(), syscall: z.string().optional(), message: z.string() }).optional(),
});
type FailureT = z.infer<typeof Failure>;

/** §5.7.4: the report written at the top of outputDir (part of the staged set) when `writeManifest: true`. */
export const MANIFEST_NAME = "subtitle-mcp-manifest.json";

/**
 * §5.7 success shape. The failure shape (isError) is `{error, failures, converted, notAttempted, excluded,
 * requestIds}`; the SDK doesn't validate structuredContent of isError results against outputSchema (OQ-17), so it
 * isn't part of this schema.
 */
/** §5.7 failure shape (structuredContent of an isError result, next to `error`). */
export const BatchFailure = z.object({
  failures: z.array(Failure),
  converted: z.number(),
  notAttempted: z.number(),
  excluded: z.array(Excluded),
  requestIds: z.array(z.string()),
});

export const BatchOutput = {
  outputDir: z.string(),
  totals: z.object({ files: z.number(), converted: z.number(), excluded: z.number(), outputs: z.number(), chunks: z.number(), elapsedMs: z.number() }),
  entries: z.array(EntryOut),
  excluded: z.array(Excluded),
  warnings: z.array(Warning),
  requestIds: z.array(z.string()),
  manifestPath: z.string().optional(),
};

interface Item {
  file: SelectedFile;
  entryName: string; // as sent (maybe aliased)
  localRelDir: string; // '/'-separated, '' for root
  localStem: string;
  aliased: boolean;
  size: number;
}

export function describeBatch(deps: Deps): string {
  return (
    "Convert many subtitle files at once, from a folder (`inputDir` + optional glob `pattern`) or a list of `paths` (exactly one of them), into a NEW folder `outputDir`, which must not exist yet (choose a new folder name, or ask the user to remove the old one). Formats can be mixed: each file is detected and converted on its own with the same preset/target/profile (at least one of preset, target, profile or profilePath), and sub-folders are kept. Large sets are split into several API requests automatically." +
    " Files in the same folder must not share a name stem (e.g. `ep1.srt` and `ep1.vtt`): that is checked before anything is uploaded and fails the whole call; rename them or convert them in separate batches." +
    " All or nothing: `outputDir` appears only when every file has converted and been written. If any file fails (conversion or write), the batch stops at that file, nothing is written, and the result lists what failed with a hint; fix it and rerun the whole batch." +
    " Always tell the user about warnings (e.g. `lossy-format`, `characters-replaced`, `frame-quantised`, `frame-rate-changed`, which flags an EBU STL frame-rate code mismatch, e.g. a 29.97 fps source written with the STL30.01 code; timings move by less than one frame, with no cumulative drift); many carry a `hint` with the fixing setting and `details` with cue numbers (for `characters-replaced`, `details.remedy`: the option, its allowed values and the candidates that keep the characters; choose among several by language, or use fpc)." +
    " Binary outputs carry `entries[].verification` (verdict lossless | quantised | lossy | unverified from reading the written file back); a clean round trip proves self-consistency through the converter's own reader, not acceptance by a playout system. A file that matches both PAC and FPC without a .pac/.fpc name fails with `ambiguous-format`; set `profile.source.format`." +
    ` Set \`writeManifest: true\` to also write the report as ${MANIFEST_NAME} inside outputDir. Use convert_subtitle for a single file or to write into an existing folder.` +
    ` ${deps.rootsText}`
  );
}

export function registerBatchTool(server: McpServer, deps: Deps): void {
  defineTool(server, deps, {
    name: "convert_batch",
    warningArray: true,
    title: "Convert a batch of subtitles",
    description: () => describeBatch(deps),
    shape: {
      inputDir: z.string().optional().describe("Absolute folder in an allowed root"),
      pattern: z.string().max(200).default("*").describe("Glob relative to inputDir, e.g. '*.srt' or '**/*.{srt,vtt}'"),
      paths: z.array(z.string()).max(1000).optional().describe("Explicit absolute file paths (instead of inputDir)"),
      outputDir: z.string().describe("Absolute path of a NEW folder (must not exist) in a writable allowed root"),
      preserveStructure: z.boolean().default(true).describe("Keep sub-folders relative to inputDir"),
      preset: z.string().max(200).optional(),
      target: z.string().max(100).optional(),
      profile: z.record(z.unknown()).optional(),
      profilePath: z.string().optional(),
      writeManifest: z.boolean().default(false).describe(`Also write the report as ${MANIFEST_NAME} inside outputDir`),
    },
    output: BatchOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: (a: any, call) => runBatch(deps, a, call),
  });
}

/** Per-call state while converting. */
interface Run {
  entries: Map<string, EntryOutT>; // converted files, by caller source
  failures: FailureT[];
  excluded: ExcludedT[];
  requestIds: string[];
  batchWarnings: WarningT[];
  /** normalised final path → source that produced it (cross-chunk clash detection, no renaming). */
  staged: Map<string, string>;
  outputs: number;
}

const failureOf = (source: string, e: ToolError, requestId?: string): FailureT => ({
  source,
  code: e.code,
  message: e.detail ?? e.title ?? e.code,
  ...(e.hint ? { hint: e.hint } : {}),
  ...(e.candidates?.length ? { candidates: e.candidates } : {}),
  ...((requestId ?? e.requestId) ? { requestId: (requestId ?? e.requestId)! } : {}),
  ...(e.path ? { path: e.path } : {}),
  ...(e.osError ? { osError: e.osError } : {}),
});

export async function runBatch(deps: Deps, a: any, call: Call) {
  const started = Date.now();
  exactlyOne(a, ["inputDir", "paths"], "the files to convert");
  if (a.preset === undefined && a.target === undefined && a.profile === undefined && a.profilePath === undefined)
    throw mcpError("invalid-arguments", "Say what to produce: give at least one of `preset`, `target`, `profile` or `profilePath`.");
  mutuallyExclusive(a, "profile", "profilePath");
  if (typeof a.outputDir !== "string" || !a.outputDir) throw mcpError("invalid-arguments", "`outputDir` is required: the path of a new folder.");

  // §5.7.1 order: outputDir guard + must-not-exist → selection → D-29 → size pre-checks → cross-device → staging dir.
  const stage = await BatchStage.prepare(deps.guard, a.outputDir, deps.log, deps.fsOps);

  const sel = a.inputDir !== undefined ? await selectFromDir(deps.guard, a.inputDir, a.pattern ?? "*", deps.cfg.batchMaxFiles) : await selectFromPaths(deps.guard, a.paths, deps.cfg.batchMaxFiles);
  if (sel.files.length + sel.pre.length === 0) throw mcpError("invalid-arguments", "No files matched.", a.inputDir !== undefined ? "Check inputDir and pattern (e.g. '**/*.srt' for sub-folders)." : undefined);
  const flat = a.inputDir === undefined || a.preserveStructure === false;

  const named = sel.files.map((f) => ({ file: f, entryName: flat ? nodePath.posix.basename(f.rel) : f.rel }));
  const groups = ambiguousGroups(named.map((n) => ({ source: n.file.source, entryName: n.entryName })));
  if (groups.length) {
    throw mcpError(
      "ambiguous-batch-names",
      `Files in the same folder share a name stem, so their outputs would collide: ${groups.map((g) => g.join(" <-> ")).join("; ")}. Nothing was sent.`,
      "Rename one of the files, or convert them in separate batches." + (flat ? " Same names from different folders are allowed with inputDir and preserveStructure:true." : ""),
      { groups },
    );
  }

  const run: Run = { entries: new Map(), failures: [], excluded: [], requestIds: [], batchWarnings: [], staged: new Map(), outputs: 0 };
  for (const p of sel.pre) {
    // Local exclusions don't block the commit (OQ-45); an explicit path that can't be used is a failure.
    if (p.status === "skipped") run.excluded.push({ source: p.source, reason: p.reason ?? "excluded" });
    else run.failures.push(failureOf(p.source, p.error ?? { source: "mcp", code: "path-not-allowed" }));
  }
  const files = sel.files.length + run.failures.length;
  const failText = () => batchFailText(a, run, 0, files - run.failures.length);

  const caps = await getCaps(deps, call);
  const profile = await loadProfile(deps, a, caps);
  const profileBytes = profile ? Buffer.byteLength(JSON.stringify(profile)) : 0;

  // Aliases for unsafe names and top-level manifest.json; per-file size pre-checks for ALL files.
  const used = new Set(named.map((n) => n.entryName.toLowerCase()));
  let aliasN = 0;
  const items: Item[] = [];
  const entryCap = Math.min(caps.zipMaxEntryBytes, caps.localMax ?? Infinity);
  for (const n of named) {
    const relDir = flat ? "" : nodePath.posix.dirname(n.entryName) === "." ? "" : nodePath.posix.dirname(n.entryName);
    const base = nodePath.posix.basename(n.entryName);
    let entryName = n.entryName;
    let aliased = false;
    if (needsAlias(n.entryName)) {
      const ext = nodePath.posix.extname(base).replace(/[^A-Za-z0-9.]/g, "");
      do entryName = `_mcp/${++aliasN}${ext}`;
      while (used.has(entryName.toLowerCase()));
      used.add(entryName.toLowerCase());
      aliased = true;
    }
    if (n.file.size > entryCap) {
      const lim = caps.localMax !== undefined && caps.localMax < caps.zipMaxEntryBytes ? { name: "SUBTITLE_MCP_MAX_BYTES", value: caps.localMax } : { name: "zip.maxEntryBytes", value: caps.zipMaxEntryBytes };
      run.failures.push(failureOf(n.file.source, tooLarge(n.file.source, lim, n.file.size).toolError));
      continue;
    }
    items.push({ file: n.file, entryName, localRelDir: relDir, localStem: stemOf(base), aliased, size: n.file.size });
  }

  const outputsPerEntry = await estimateOutputsPerEntry(deps, call, a, profile);
  const ccaps: ChunkCaps = { maxEntries: caps.zipMaxEntries, maxUnpacked: caps.zipMaxUnpacked, maxZipBytes: caps.jsonDecoded, maxBody: caps.jsonBody, maxResponse: deps.cfg.batchMaxResponseBytes, profileBytes, outputsPerEntry };
  const { chunks, oversized } = chunkItems(items, ccaps);
  for (const it of oversized) {
    run.failures.push(failureOf(it.file.source, tooLarge(it.file.source, { name: "json.maxDecodedContentBytes", value: caps.jsonDecoded }, it.size, "Convert this file on its own with convert_subtitle, or split it.").toolError));
  }
  call.log.files = files;
  call.log.source = "path";
  call.log.committed = false;
  if (run.failures.length) throw failed(run, a, files, 0, failText());

  // Before the first request: same filesystem (D-41) and a staging folder we can use.
  await stage.check();

  let chunkCount = 0;
  let converted = 0;
  const c: ChunkCtx = { deps, call, a, profile, run, stage, ccaps };
  try {
    for (let k = 0; k < chunks.length; k++) {
      const r = await runChunk(c, chunks[k], withSuffix(call.requestId, `.c${k + 1}`), () => chunkCount++);
      converted += r.converted;
      await stage.touch();
      await call.progress(`Batch: ${k + 1}/${chunks.length} chunks done`);
      if (r.stop) {
        // Stop at the first failure (§5.7.4): nothing is written, so no point converting more.
        await stage.discard();
        call.log.chunks = chunkCount;
        if (r.stop.kind === "fatal") {
          const tf = new ToolFailure(r.stop.error);
          throw withPartial(tf, failurePartial(run, converted, files - converted - run.failures.length), batchFailText(a, run, converted, files - converted - run.failures.length, r.stop.error));
        }
        throw failed(run, a, files, converted, batchFailText(a, run, converted, files - converted - run.failures.length));
      }
    }
  } catch (e) {
    await stage.discard();
    throw e;
  }
  call.log.chunks = chunkCount;

  const list = sel.files.filter((f) => run.entries.has(f.source)).map((f) => run.entries.get(f.source)!);
  const structured: any = {
    outputDir: a.outputDir,
    totals: { files: files + run.excluded.length, converted: list.length, excluded: run.excluded.length, outputs: run.outputs, chunks: chunkCount, elapsedMs: 0 },
    entries: list,
    excluded: run.excluded,
    warnings: run.batchWarnings,
    requestIds: run.requestIds,
  };
  try {
    if (a.writeManifest) {
      structured.manifestPath = stage.finalPath("", MANIFEST_NAME);
      structured.totals.elapsedMs = Date.now() - started;
      await stage.write("", MANIFEST_NAME, Buffer.from(JSON.stringify(structured, null, 2) + "\n", "utf8"), "the manifest", run.staged.get(normKey(stage.finalPath("", MANIFEST_NAME))));
    }
    await stage.commit();
  } catch (e) {
    await stage.discard();
    if (e instanceof ToolFailure && WRITE_FAILURE_CODES.has(e.toolError.code)) {
      run.failures.push(failureOf(e.toolError.path ?? a.outputDir, e.toolError));
      throw failed(run, a, files, converted, batchFailText(a, run, converted, 0));
    }
    if (e instanceof ToolFailure) throw withPartial(e, failurePartial(run, converted, 0), batchFailText(a, run, converted, 0, e.toolError));
    throw e;
  }
  structured.totals.elapsedMs = Date.now() - started;
  call.log.committed = true;
  return { structured, summary: batchSummary(a, structured, list, run) };
}

function failurePartial(run: Run, converted: number, notAttempted: number) {
  return { failures: run.failures, converted, notAttempted: Math.max(0, notAttempted), excluded: run.excluded, requestIds: run.requestIds };
}

/** The D-44 batch-failed result: nothing written, failures[] per file. */
function failed(run: Run, a: any, files: number, converted: number, text: string): ToolFailure {
  const notAttempted = files - converted - run.failures.length;
  const err: ToolError = {
    source: "mcp",
    code: "batch-failed",
    detail: `${run.failures.length} file${run.failures.length === 1 ? "" : "s"} failed; nothing was written and ${a.outputDir} was not created.`,
    hint: "Fix the file(s) listed in failures[] (each has its own hint), then rerun the whole batch.",
  };
  return withPartial(new ToolFailure(err), failurePartial(run, converted, notAttempted), text);
}

async function estimateOutputsPerEntry(deps: Deps, call: Call, a: any, profile: any): Promise<number> {
  let additional: unknown = profile?.target?.additional;
  if (additional === undefined && a.preset !== undefined) {
    try {
      const res = await deps.api.request({ method: "GET", path: `/v1/profiles/${encodeURIComponent(a.preset)}`, kind: "metadata" }, { requestId: withSuffix(call.requestId, ".p"), signal: call.signal, stats: newStats() });
      additional = (res.json as any)?.resolved?.target?.additional;
    } catch (e) {
      if (!(e instanceof ToolFailure) || e.toolError.code === "cancelled") throw e;
    }
  }
  return 1 + (Array.isArray(additional) ? additional.length : 0);
}

type Stop = { kind: "failed" } | { kind: "fatal"; error: ToolError };

type ChunkCtx = { deps: Deps; call: Call; a: any; profile: any; run: Run; stage: BatchStage; ccaps: ChunkCaps };

/** Sends one chunk (failFast:true); halves on 413 / running-phase 504. Returns how many files converted and a stop. */
async function runChunk(c: ChunkCtx, items: Item[], rid: string, countChunk: () => void): Promise<{ converted: number; stop?: Stop }> {
  const { deps, call, a, run } = c;
  const datas: Uint8Array[] = [];
  for (const it of items) {
    try {
      datas.push(await readFileChecked(it.file.real, it.file.source, { name: "zip.maxEntryBytes", value: c.ccaps.maxZipBytes }));
    } catch (e) {
      if (!(e instanceof ToolFailure)) throw e;
      run.failures.push(failureOf(it.file.source, e.toolError));
      return { converted: 0, stop: { kind: "failed" } };
    }
  }
  const zip = buildZip(items.map((it, i) => ({ name: it.entryName, data: datas[i] })), await getRatio(c));
  const body: Record<string, unknown> = { content: Buffer.from(zip).toString("base64"), contentEncoding: "base64", responseEncoding: "base64", failFast: true };
  if (a.preset !== undefined) body.preset = a.preset;
  if (a.target !== undefined) body.target = a.target;
  if (c.profile !== undefined) body.profile = c.profile;
  countChunk();
  let res;
  try {
    res = await deps.api.request({ method: "POST", path: "/v1/convert/json", kind: "conversion", json: body, batch: true }, { ...call, requestId: rid });
  } catch (e) {
    if (!(e instanceof ToolFailure)) throw e;
    const te = e.toolError;
    if (te.requestId) run.requestIds.push(te.requestId);
    const halve = te.status === 413 || te.code === "zip-limits-exceeded" || (te.code === "conversion-timeout" && timeoutPhase(te) === "running");
    if (te.status === 413) deps.limits.invalidate();
    if (halve && items.length > 1) {
      const mid = Math.ceil(items.length / 2);
      const r1 = await runChunk(c, items.slice(0, mid), withSuffix(rid, "a"), countChunk);
      if (r1.stop) return r1;
      const r2 = await runChunk(c, items.slice(mid), withSuffix(rid, "b"), countChunk);
      return { converted: r1.converted + r2.converted, ...(r2.stop ? { stop: r2.stop } : {}) };
    }
    if (halve) {
      run.failures.push(failureOf(items[0].file.source, te));
      return { converted: 0, stop: { kind: "failed" } };
    }
    if (te.code === "ambiguous-batch-names") return { converted: 0, stop: { kind: "fatal", error: mapAmbiguous(c, items, te) } };
    // failFast per-entry problem [R-12]: named by `entry`, else /content/entries/<i>.
    const idx = failingEntryIndex(te, items);
    if (idx !== undefined) {
      run.failures.push(failureOf(items[idx].file.source, withEntryHint(te)));
      return { converted: idx, stop: { kind: "failed" } };
    }
    return { converted: 0, stop: { kind: "fatal", error: te } };
  }
  const r: any = res.json ?? {};
  if (res.requestId) run.requestIds.push(res.requestId);
  if (!Array.isArray(r.entries) || !Array.isArray(r.outputs)) {
    return { converted: 0, stop: { kind: "fatal", error: { source: "mcp", code: "api-protocol-error", detail: "The batch response has no entries/outputs manifest.", hint: "Report this with the requestId.", ...(res.requestId ? { requestId: res.requestId } : {}) } } };
  }
  const byEntry = new Map(items.map((it) => [it.entryName, it]));
  const reported = new Map<string, any>();
  for (const me of r.entries) {
    const key = String(me?.source ?? "");
    if (!byEntry.has(key)) {
      run.batchWarnings.push({ code: "mcp-unknown-entry", message: `The API reported an entry the MCP did not send: ${key.slice(0, 200)}` });
      continue;
    }
    reported.set(key, me);
  }
  for (const w of mapWarnings(r.warnings)) run.batchWarnings.push(w);
  // All or nothing: every sent entry must be "ok" before anything from this chunk is written.
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const me = reported.get(it.entryName);
    if (me?.status === "ok") continue;
    if (me?.status === "error") {
      run.failures.push(failureOf(it.file.source, withEntryHint(mapEntryError(c, me.error ?? {}, res.requestId))));
    } else {
      const what = !me ? "was sent but not reported by the API" : me.status === "skipped" ? `was skipped by the API (${String(me.reason ?? "no reason").slice(0, 100)})` : `has the unknown status '${String(me.status).slice(0, 50)}'`;
      run.failures.push({ source: it.file.source, code: "entry-not-converted", message: `${it.file.source} ${what}; every file must convert.`, hint: "Check the file, or exclude it from the batch, then rerun.", ...(res.requestId ? { requestId: res.requestId } : {}) });
    }
    return { converted: i, stop: { kind: "failed" } };
  }
  const outputsBySource = new Map<string, any[]>();
  for (const o of r.outputs) {
    const s = String(o?.source ?? "");
    if (!outputsBySource.has(s)) outputsBySource.set(s, []);
    outputsBySource.get(s)!.push(o);
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const me = reported.get(it.entryName);
    const entry: EntryOutT = { source: it.file.source, outputs: [], warnings: mapWarnings(me.warnings) };
    if (me.detected && typeof me.detected === "object") {
      entry.detected = { format: String(me.detected.format ?? ""), id: String(me.detected.id ?? ""), encoding: String(me.detected.encoding ?? ""), ...(me.kind || me.detected.kind ? { kind: String(me.kind ?? me.detected.kind) } : {}), ...(me.codePage || me.detected.codePage ? { codePage: String(me.codePage ?? me.detected.codePage) } : {}) };
    }
    for (const o of outputsBySource.get(it.entryName) ?? []) {
      try {
        const { relDir, name, renamed } = localTarget(it, String(o.fileName ?? ""));
        if (renamed) entry.warnings.push({ code: "mcp-output-renamed", message: `The converter named the output '${String(o.fileName).slice(0, 200)}'; it was written as '${name}'.` });
        const data = o.contentEncoding === "base64" ? Buffer.from(String(o.content ?? ""), "base64") : Buffer.from(String(o.content ?? ""), "utf8");
        const key = normKey(c.stage.finalPath(relDir, name));
        const shown = await c.stage.write(relDir, name, data, it.file.source, run.staged.get(key));
        run.staged.set(key, it.file.source);
        entry.outputs.push(shown);
        const v = mapVerification(o.verification);
        if (v) (entry.verification ??= []).push({ output: shown, ...v });
        run.outputs++;
      } catch (e) {
        if (!(e instanceof ToolFailure)) throw e;
        if (e.toolError.code === "ambiguous-batch-names") return { converted: i, stop: { kind: "fatal", error: e.toolError } };
        if (!WRITE_FAILURE_CODES.has(e.toolError.code)) throw e;
        run.failures.push(failureOf(it.file.source, e.toolError, res.requestId));
        return { converted: i, stop: { kind: "failed" } };
      }
    }
    run.entries.set(it.file.source, entry);
  }
  return { converted: items.length };
}

/** [R-12] the failing entry of a failFast problem: the `entry` extension, else `/content/entries/<i>`. */
function failingEntryIndex(te: ToolError, items: Item[]): number | undefined {
  if (typeof te.entry === "string") {
    const i = items.findIndex((it) => it.entryName === te.entry);
    if (i >= 0) return i;
  }
  const m = /^\/content\/entries\/(\d+)$/.exec(te.errors?.[0]?.pointer ?? "");
  if (m && Number(m[1]) < items.length) return Number(m[1]);
  return undefined;
}

const ENTRY_HINTS: Record<string, string> = {
  "format-not-detected": "Set profile.source.format (see list_formats), or run detect_format.",
  "invalid-binary-input": "Send binary files via path or base64; set profile.source.format if the wrong format was detected.",
  "input-limits-exceeded": "Split the file.",
  "conversion-failed": "Try removing the named operation from the profile.",
  "ambiguous-format": MCP_HINTS["ambiguous-format"],
};
function withEntryHint(te: ToolError): ToolError {
  const extra = ENTRY_HINTS[te.code];
  if (!extra || te.hint?.includes(extra)) return te;
  return { ...te, hint: te.hint ? `${te.hint} ${extra}` : extra };
}

async function getRatio(c: ChunkCtx): Promise<number> {
  const st = await c.deps.limits.get({ requestId: withSuffix(c.call.requestId, ".l"), signal: c.call.signal, stats: newStats() });
  return st.kind === "ok" ? st.limits.zip.maxRatio ?? 100 : 100;
}

/** §5.7.2: local name from the entry, never from matching fileNames. */
function localTarget(it: Item, apiName: string): { relDir: string; name: string; renamed: boolean } {
  const entryStem = stemOf(it.entryName);
  let name: string;
  let renamed = false;
  if (apiName.startsWith(entryStem) && apiName.length > entryStem.length) {
    name = it.localStem + apiName.slice(entryStem.length);
  } else {
    renamed = true;
    name = it.aliased ? it.localStem + nodePath.posix.extname(apiName) : nodePath.posix.basename(apiName);
  }
  return { relDir: it.localRelDir, name: sanitizeOutputName(name), renamed };
}

function mapEntryError(c: ChunkCtx, e: any, requestId?: string): ToolError {
  const te: ToolError = {
    source: "api",
    status: typeof e.status === "number" ? e.status : undefined,
    code: typeof e.code === "string" ? e.code : "http-" + (e.status ?? "error"),
    ...(e.title ? { title: String(e.title) } : {}),
    ...(e.detail ? { detail: String(e.detail) } : {}),
    ...(e.hint ? { hint: String(e.hint) } : {}),
    ...(requestId ?? e.requestId ? { requestId: requestId ?? e.requestId } : {}),
  };
  if (Array.isArray(e.candidates)) te.candidates = e.candidates.map(String);
  if (Array.isArray(e.errors)) te.errors = e.errors.map((x: any) => ({ pointer: String(x.pointer ?? ""), message: String(x.message ?? ""), ...(x.hint ? { hint: String(x.hint) } : {}) }));
  if (c.deps.cfg.includeDebug && c.deps.cfg.mode !== "hosted" && e.debug !== undefined) te.debug = e.debug;
  return te;
}

function mapAmbiguous(c: ChunkCtx, items: Item[], te: ToolError): ToolError {
  const map = new Map(items.map((it) => [it.entryName.toLowerCase(), it.file.source]));
  const toLocal = (n: string) => map.get(n.toLowerCase()) ?? n;
  const groups = te.groups?.map((g) => g.map(toLocal));
  const outputs = te.outputs?.map((o) => {
    const dir = nodePath.posix.dirname(o);
    return c.stage.finalPath(dir === "." ? "" : dir, nodePath.posix.basename(o));
  });
  const errors = te.errors?.map((e) => ({ ...e, pointer: toLocal(e.pointer) }));
  if (groups?.length) c.deps.log.warn("API reported ambiguous batch names the local pre-check missed", { groups: groups.length });
  const parts: string[] = [];
  if (groups?.length) parts.push(`clashing files: ${groups.map((g) => g.join(" <-> ")).join("; ")}`);
  if (outputs?.length) parts.push(`clashing outputs: ${outputs.join(", ")}`);
  return { ...te, ...(groups ? { groups } : {}), ...(outputs ? { outputs } : {}), ...(errors ? { errors } : {}), detail: `${te.detail ?? "Ambiguous batch names."}${parts.length ? " (" + parts.join("; ") + ")" : ""}` };
}

function frameRateLine(list: EntryOutT[]): string | undefined {
  const frc = list.filter((e) => e.warnings.some((w) => w.code === "frame-rate-changed"));
  if (!frc.length) return undefined;
  const msg = frc[0].warnings.find((w) => w.code === "frame-rate-changed")!.message;
  return `Frame rate changed on ${frc.length} file${frc.length === 1 ? "" : "s"}: ${msg}`;
}

function batchSummary(a: any, s: any, list: EntryOutT[], run: Run): string {
  const t = s.totals;
  let first = `Converted ${t.converted} file${t.converted === 1 ? "" : "s"} (${t.outputs} output${t.outputs === 1 ? "" : "s"}) in ${t.chunks} request${t.chunks === 1 ? "" : "s"} → ${a.outputDir} (new folder).`;
  if (run.excluded.length) {
    first += ` ${run.excluded.length} file${run.excluded.length === 1 ? "" : "s"} excluded (${run.excluded.slice(0, 5).map((x) => `${nodePath.basename(x.source)}: ${x.reason}`).join(", ")}${run.excluded.length > 5 ? ", …" : ""}).`;
  }
  const lines = [first];
  const fr = frameRateLine(list);
  if (fr) lines.push(fr);
  const vs = list.flatMap((e) => e.verification ?? []);
  if (vs.length) {
    const by = (k: string) => vs.filter((v) => v.verdict === k);
    const counts = ["lossless", "quantised", "lossy", "unverified"].map((k) => [k, by(k).length] as const).filter(([, n]) => n);
    let line = `Verification of ${vs.length} binary output${vs.length === 1 ? "" : "s"}: ${counts.map(([k, n]) => `${n} ${k}`).join(", ")}.`;
    const bad = [...by("lossy"), ...by("unverified")];
    for (const v of bad.slice(0, 5)) line += ` ${nodePath.basename(v.output)}: ${verificationText(v)}.`;
    if (bad.length > 5) line += ` …and ${bad.length - 5} more (see entries[].verification).`;
    lines.push(line);
  }
  const warnCount = list.reduce((n, e) => n + e.warnings.length, 0) + run.batchWarnings.length;
  if (warnCount) lines.push(`${warnCount} warning(s); report them to the user (see entries[].warnings and warnings).`);
  if (s.manifestPath) lines.push(`Manifest: ${s.manifestPath}`);
  return lines.join("\n");
}

function batchFailText(a: any, run: Run, converted: number, notAttempted: number, whole?: ToolError): string {
  const lines = [`Batch failed; nothing was written (${a.outputDir} was not created).`];
  const fr = frameRateLine([...run.entries.values()]);
  if (fr) lines.push(fr);
  if (whole) lines.push(`${whole.code}: ${whole.detail ?? whole.title ?? ""}${whole.hint ? ` Hint: ${whole.hint}` : ""}`);
  for (const f of run.failures.slice(0, 20)) {
    lines.push(`${f.path ?? nodePath.basename(f.source)}: ${f.code}${f.osError ? ` (${f.osError.code})` : ""}: ${f.message}${f.hint ? ` Hint: ${f.hint}` : ""}`);
  }
  if (run.failures.length > 20) lines.push(`…and ${run.failures.length - 20} more (see failures[]).`);
  const parts: string[] = [];
  if (converted) parts.push(`${converted} file${converted === 1 ? "" : "s"} had converted before the stop and were discarded`);
  if (notAttempted > 0) parts.push(`${notAttempted} ${notAttempted === 1 ? "was" : "were"} not attempted`);
  lines.push((parts.length ? parts.join("; ") + ". " : "") + (whole ? "Fix the problem above and rerun the whole batch." : "Fix the file(s) above and rerun the whole batch."));
  return lines.join("\n");
}
