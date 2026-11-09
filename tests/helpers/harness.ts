import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupServer } from "msw/node";
import { http, HttpResponse, type HttpHandler } from "msw";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildDeps, type DepsOptions } from "../../src/app.js";
import { createServer } from "../../src/server.js";
import { defaultConfig, type Config } from "../../src/config.js";
import { createLogger } from "../../src/log.js";
import type { Root } from "../../src/fs/guard.js";

export const API = "http://api.test";

export const LIMITS = {
  maxUploadBytes: 10485760,
  maxRequestBodyBytes: { multipart: 10747904, json: 14112088 },
  json: { maxDecodedContentBytes: 10485760, base64: "x" },
  maxProfileBytes: 65536, maxCues: 200000, maxLineChars: 10000,
  conversionTimeoutSeconds: 30, queue: { capacity: 32, depth: 0 }, rateLimitPerMinute: 0, auth: { required: false }, binary: { ebuStlMaxBytes: 2047999 },
};

export const FORMATS = [
  { id: "subrip", name: "SubRip", aliases: ["srt"], extension: ".srt", alternateExtensions: [], textBased: true, frameBased: false, styleSupport: false, positionSupport: false, canRead: true, canWrite: true, source: "libse", mediaType: "application/x-subrip", kind: "text", lossy: false, options: null },
  { id: "webvtt", name: "WebVTT", aliases: ["vtt"], extension: ".vtt", alternateExtensions: [], textBased: true, frameBased: false, styleSupport: true, positionSupport: true, canRead: true, canWrite: true, source: "libse", mediaType: "text/vtt", kind: "text", lossy: false, options: null },
  { id: "ebustl", name: "EBU STL", aliases: ["ebu"], extension: ".stl", alternateExtensions: [], textBased: false, frameBased: true, styleSupport: false, positionSupport: false, canRead: true, canWrite: true, source: "libse", mediaType: "application/octet-stream", kind: "binary", lossy: false, options: "ebuStl" },
  { id: "avidstl", name: "Avid STL", aliases: [], extension: ".stl", alternateExtensions: [], textBased: false, frameBased: false, styleSupport: false, positionSupport: false, canRead: true, canWrite: false, source: "libse", mediaType: "application/octet-stream", kind: "binary", lossy: false },
];
export const FORMATS_V10 = FORMATS.filter((f) => f.kind === "text").map(({ kind: _k, lossy: _l, options: _o, ...rest }) => rest);

export const SRT = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";
export const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n";

export function problem(status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return HttpResponse.json(
    { type: `https://x/errors.md#${code}`, title: code, status, code, detail: `detail for ${code}`, hint: "API hint.", requestId: "api-rid", ...extra },
    { status, headers: { "Content-Type": "application/problem+json", ...headers } },
  );
}

export function convertOk(outputs: { fileName: string; content: string; contentEncoding?: string; formatId?: string; source?: string; kind?: string; verification?: unknown }[], extra: Record<string, unknown> = {}) {
  return {
    outputs: outputs.map((o) => ({ format: o.formatId === "ebustl" ? "EBU STL" : "WebVTT", formatId: o.formatId ?? "webvtt", mediaType: o.formatId === "ebustl" ? "application/octet-stream" : "text/vtt", contentEncoding: "text", encoding: "utf-8", cues: "1", kind: o.kind ?? "text", ...o })),
    detected: { format: "SubRip", id: "subrip", encoding: "utf-8", encodingConfidence: "utf8-valid", language: "en", paragraphs: "1", kind: "text" },
    stats: { paragraphsIn: 1, paragraphsOut: "1", elapsedMs: 4, queueWaitMs: 0 },
    warnings: [],
    profile: { target: { format: "webvtt" } },
    ...extra,
  };
}

export const mswServer = setupServer();

export interface Recorded {
  url: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
  raw: string;
}
export const recorded: Recorded[] = [];
mswServer.events.on("request:start", async ({ request }) => {
  const raw = request.method === "POST" ? await request.clone().text() : "";
  let body: any;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    body = undefined;
  }
  recorded.push({ method: request.method, url: request.url, path: new URL(request.url).pathname, headers: Object.fromEntries(request.headers.entries()), body, raw });
});

export const baseHandlers = (opts: { limits?: "ok" | "404"; formats?: unknown[] } = {}): HttpHandler[] => [
  http.get(`${API}/healthz`, () => HttpResponse.json({ status: "ok", version: "1.3.0", libse: "5.1.0" })),
  http.get(`${API}/v1/limits`, () => (opts.limits === "404" ? problem(404, "not-found") : HttpResponse.json(LIMITS))),
  http.get(`${API}/v1/formats`, () => HttpResponse.json(opts.formats ?? FORMATS)),
];

export function tmpDir(prefix = "mcp-"): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export interface Harness {
  client: Client;
  deps: ReturnType<typeof buildDeps>;
  logs: string[];
  close(): Promise<void>;
}

export async function harness(cfg: Partial<Config> = {}, opts: DepsOptions & { roots?: Root[] } = {}): Promise<Harness> {
  const logs: string[] = [];
  const config = defaultConfig({ apiUrl: API, ...cfg });
  const log = createLogger("debug", config.logPaths, (l) => logs.push(l));
  const deps = buildDeps(config, { log, ...opts });
  const server = createServer(deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  await server.connect(st);
  await client.connect(ct);
  return {
    client,
    deps,
    logs,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export async function callTool(h: Harness, name: string, args: Record<string, unknown>, extra: { progress?: (m: string) => void; signal?: AbortSignal } = {}) {
  const r: any = await h.client.callTool({ name, arguments: args }, undefined, {
    ...(extra.progress ? { onprogress: (p: any) => extra.progress!(p.message) } : {}),
    ...(extra.signal ? { signal: extra.signal } : {}),
  });
  return r as { isError?: boolean; content: any[]; structuredContent: any };
}
