import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import { InboundTokens } from "../auth.js";
import { buildDeps } from "../app.js";
import { createServer } from "../server.js";
import type { Deps } from "../context.js";
import type { Root } from "../fs/guard.js";
import { startSweeper } from "../fs/sweep.js";
import { VERSION } from "../version.js";

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function hostOf(h: string | undefined): string | undefined {
  if (!h) return undefined;
  const m = /^(\[[^\]]+\]|[^:]+)(:\d+)?$/.exec(h.trim());
  return m ? m[1].toLowerCase() : undefined;
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | "too-large"> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) return "too-large";
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export interface HttpHandle {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

export async function startHttp(cfg: Config, roots: Root[], log: Logger, depsOverride?: Partial<Parameters<typeof buildDeps>[1]>): Promise<HttpHandle> {
  const tokens = new InboundTokens(cfg.httpTokens, cfg.httpTokenFile, log);
  // Client roots are ignored in HTTP mode; only configured roots count.
  const deps: Deps = buildDeps(cfg, { log, roots, ...depsOverride });
  const allowedHosts = new Set(cfg.allowedHosts.map((h) => h.toLowerCase()));
  const allowedOrigins = new Set(cfg.allowedOrigins);

  const bodyLimit = () => {
    const st = deps.limits.peek();
    return st?.kind === "ok" && st.limits.bodyJson ? Math.ceil(st.limits.bodyJson * 1.1) : 16 * 1024 * 1024;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET" }).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ status: "ok", version: VERSION }));
      return;
    }
    if (url.pathname !== "/mcp") {
      jsonRpcError(res, 404, -32601, "not found");
      return;
    }
    // DNS-rebinding protection.
    const host = hostOf(req.headers.host);
    if (!host || !allowedHosts.has(host)) {
      log.warn("host-rejected", { host: req.headers.host?.slice(0, 100) });
      jsonRpcError(res, 403, -32000, "forbidden: Host not allowed");
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const ok = allowedOrigins.size ? allowedOrigins.has(origin) : LOOPBACK_ORIGIN.test(origin);
      if (!ok) {
        log.warn("origin-rejected", { origin: origin.slice(0, 100) });
        jsonRpcError(res, 403, -32000, "forbidden: Origin not allowed");
        return;
      }
    }
    // Inbound access token (D-14), before anything reaches the MCP server.
    const auth = tokens.check(req.headers.authorization);
    if (!auth.ok) {
      log.warn("auth-failed", { remote: req.socket.remoteAddress, reason: auth.reason });
      jsonRpcError(res, 401, -32001, "unauthorized", { "WWW-Authenticate": 'Bearer realm="subtitleedit-converter-mcp"' });
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: POST only)" }, id: null }));
      return;
    }
    log.debug("auth-ok", { token: auth.fp });
    const body = await readBody(req, bodyLimit());
    if (body === "too-large") {
      jsonRpcError(res, 413, -32000, "request body too large");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      jsonRpcError(res, 400, -32700, "parse error");
      return;
    }
    // Stateless: a fresh server + transport per request, no session id.
    const server = createServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (e) {
      log.error("mcp request failed", { error: (e as Error).message });
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "internal error");
    }
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => {
      log.error("http handler failed", { error: (e as Error).message });
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "internal error");
    });
  });
  const { host, port } = cfg.http!;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const stopSweep = roots.some((r) => r.writable) ? startSweeper(deps.guard.roots, cfg.partialMaxAgeMs, log) : undefined;
  log.info("listening", { transport: "http", host, port: actualPort });
  return {
    server,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        stopSweep?.();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
