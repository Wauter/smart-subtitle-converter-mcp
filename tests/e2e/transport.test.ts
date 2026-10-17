import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = path.join(ROOT, "dist", "index.js");
const TOKEN_A = "a".repeat(40);
const TOKEN_B = "b".repeat(40);
const API_KEY = "upstream-secret-key-123";

// ---- fake API recording upstream headers ----
let api: http.Server;
let apiUrl: string;
const upstream: { url: string; headers: http.IncomingHttpHeaders }[] = [];
beforeAll(async () => {
  if (!fs.existsSync(BIN)) throw new Error("run `npm run build` before the e2e tests");
  api = http.createServer((req, res) => {
    upstream.push({ url: req.url ?? "", headers: req.headers });
    const json = (s: number, b: unknown) => {
      res.writeHead(s, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (req.url === "/healthz") return json(200, { status: "ok", version: "1.1.0", libse: "5.1.0" });
    if (req.url?.startsWith("/v1/formats")) return json(200, [{ id: "webvtt", name: "WebVTT", aliases: [], extension: ".vtt", canRead: true, canWrite: true, kind: "text" }]);
    if (req.url === "/v1/limits") return json(404, { status: 404, code: "not-found", title: "x", detail: "x", hint: "x" });
    json(404, { status: 404, code: "not-found" });
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  apiUrl = `http://127.0.0.1:${(api.address() as any).port}`;
});
afterAll(() => new Promise<void>((r) => api.close(() => r())));

function run(args: string[], env: Record<string, string | undefined>): { child: ChildProcess; stdout: () => string; stderr: () => string; exited: Promise<number | null> } {
  let out = "";
  let err = "";
  const child = spawn(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, SUBTITLE_API_URL: apiUrl, ...env } as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (err += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  return { child, stdout: () => out, stderr: () => err, exited };
}

async function waitFor(f: () => boolean, ms = 10000) {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("stdio", () => {
  it("writes nothing but JSON-RPC to stdout", async () => {
    const p = run([], { SUBTITLE_MCP_LOG_LEVEL: "debug" });
    const send = (m: unknown) => p.child.stdin!.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_formats", arguments: {} } });
    const responses = () => p.stdout().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.id !== undefined);
    await waitFor(() => responses().length >= 3);
    p.child.stdin!.end();
    await p.exited;
    const lines = p.stdout().split("\n").filter(Boolean);
    for (const l of lines) expect(JSON.parse(l).jsonrpc).toBe("2.0");
    expect(responses().map((m) => m.id)).toEqual([1, 2, 3]);
    // No folders configured and a client without roots: the path tools' descriptions switch from "none yet" to
    // "none", announced with tools/list_changed (the only notification allowed here).
    const notes = lines.map((l) => JSON.parse(l)).filter((m) => m.id === undefined);
    for (const n of notes) expect(n.method).toBe("notifications/tools/list_changed");
    expect(responses()[2].result.structuredContent.formats[0].id).toBe("webvtt");
    expect(p.stderr()).toMatch(/"msg":"tool"/);
  });
});

describe("startup validation", () => {
  it.each([
    [["--http", "0"], {}, /inbound access token/],
    [["--http", "0"], { SUBTITLE_MCP_HTTP_TOKEN: "short" }, /at least 32/],
    [["--http", "0"], { SUBTITLE_MCP_HTTP_TOKEN_FILE: "/nonexistent/token" }, /missing or unreadable/],
    [[], { SUBTITLE_API_KEY: "a", SUBTITLE_API_KEY_FILE: "/x" }, /not both/],
    [[], { SUBTITLE_API_KEY_FILE: "/nonexistent/key" }, /missing or unreadable/],
    [[], { SUBTITLE_MCP_ALLOWED_DIRS: "/nonexistent-root-dir" }, /does not exist/],
  ])("%j %j fails", async (args, env, msg) => {
    const p = run(args as string[], env as Record<string, string>);
    expect(await p.exited).not.toBe(0);
    expect(p.stderr()).toMatch(msg as RegExp);
    expect(p.stderr()).not.toContain("short\n");
  });
});

describe("streamable HTTP sidecar", () => {
  let proc: ReturnType<typeof run>;
  let base: string;
  let tokenFile: string;
  let keyFile: string;
  let tmp: string;
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
    tokenFile = path.join(tmp, "tokens");
    keyFile = path.join(tmp, "apikey");
    fs.writeFileSync(tokenFile, `# tokens\n${TOKEN_B}\n`);
    fs.writeFileSync(keyFile, `${API_KEY}\n`);
    proc = run(["--http", "127.0.0.1:0"], { SUBTITLE_MCP_HTTP_TOKEN: TOKEN_A, SUBTITLE_MCP_HTTP_TOKEN_FILE: tokenFile, SUBTITLE_API_KEY_FILE: keyFile, SUBTITLE_MCP_LOG_LEVEL: "debug" });
    await waitFor(() => /"msg":"listening".*"port":(\d+)/.test(proc.stderr()));
    const port = /"msg":"listening".*"port":(\d+)/.exec(proc.stderr())![1];
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    proc.child.kill("SIGTERM");
    await proc.exited;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const rpc = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } };
  const parse = async (r: Response) => {
    const t = await r.text();
    const data = t.split("\n").find((l) => l.startsWith("data: "));
    return JSON.parse(data ? data.slice(6) : t);
  };

  it("/healthz needs no token", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "ok", version: expect.any(String) });
  });

  it("401 without or with a wrong token, JSON-RPC body and WWW-Authenticate", async () => {
    const variants: Record<string, string>[] = [{}, { authorization: "Bearer wrong" }, { authorization: TOKEN_A }];
    for (const h of variants) {
      const r = await rpc(init, h);
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toBe('Bearer realm="subtitleedit-converter-mcp"');
      expect(((await r.json()) as any).error.code).toBe(-32001);
    }
    expect(proc.stderr()).toMatch(/"msg":"auth-failed".*"reason":"missing"/);
    expect(proc.stderr()).not.toContain("Bearer wrong");
  });

  it("each configured token works; stateless (no session id)", async () => {
    for (const t of [TOKEN_A, TOKEN_B]) {
      const r = await rpc(init, { authorization: `Bearer ${t}` });
      expect(r.status).toBe(200);
      expect(r.headers.get("mcp-session-id")).toBeNull();
      expect((await parse(r)).result.serverInfo.name).toBe("subtitleedit-converter-mcp");
    }
  });

  it("GET and DELETE return 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      const r = await fetch(`${base}/mcp`, { method, headers: { authorization: `Bearer ${TOKEN_A}` } });
      expect(r.status).toBe(405);
    }
  });

  it("rejects foreign Host and Origin headers", async () => {
    const hostReq = await new Promise<number>((resolve) => {
      const u = new URL(base);
      const req = http.request({ host: u.hostname, port: u.port, path: "/mcp", method: "POST", headers: { host: "evil.example", authorization: `Bearer ${TOKEN_A}`, "content-type": "application/json" } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.end(JSON.stringify(init));
    });
    expect(hostReq).toBe(403);
    const r = await rpc(init, { authorization: `Bearer ${TOKEN_A}`, origin: "https://evil.example" });
    expect(r.status).toBe(403);
    const ok = await rpc(init, { authorization: `Bearer ${TOKEN_A}`, origin: "http://localhost:6274" });
    expect(ok.status).toBe(200);
  });

  it("token rotation via the token file works without a restart", async () => {
    const C = "c".repeat(40);
    fs.writeFileSync(tokenFile, `${C}\n`);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(tokenFile, later, later);
    expect((await rpc(init, { authorization: `Bearer ${C}` })).status).toBe(200);
    expect((await rpc(init, { authorization: `Bearer ${TOKEN_B}` })).status).toBe(401);
  });

  it("upstream Authorization is always the configured key (incl. _FILE reload); client headers never reach the API", async () => {
    upstream.length = 0;
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_formats", arguments: {} } };
    const r = await rpc(call, { authorization: `Bearer ${TOKEN_A}`, "x-subtitle-api-key": "client-key", "x-api-key": "client-key2", cookie: "c=1" });
    const body = await parse(r);
    expect(body.result.structuredContent.formats[0].id).toBe("webvtt");
    const fm = upstream.filter((u) => u.url.startsWith("/v1/formats"));
    expect(fm.length).toBeGreaterThan(0);
    for (const u of upstream.filter((x) => x.url !== "/healthz")) {
      expect(u.headers.authorization).toBe(`Bearer ${API_KEY}`);
      expect(u.headers["x-subtitle-api-key"]).toBeUndefined();
      expect(u.headers["x-api-key"]).toBeUndefined();
      expect(u.headers.cookie).toBeUndefined();
      expect(u.headers["x-request-id"]).toMatch(/^mcp-/);
    }
    // key file rotation
    fs.writeFileSync(keyFile, "rotated-key-456\n");
    const later = new Date(Date.now() + 10000);
    fs.utimesSync(keyFile, later, later);
    upstream.length = 0;
    await parse(await rpc(call, { authorization: `Bearer ${TOKEN_A}` }));
    expect(upstream.find((u) => u.url.startsWith("/v1/formats"))!.headers.authorization).toBe("Bearer rotated-key-456");
    // secrets never logged or returned
    const all = proc.stderr() + JSON.stringify(body);
    for (const s of [API_KEY, "rotated-key-456", TOKEN_A, TOKEN_B, "client-key"]) expect(all).not.toContain(s);
  });
});
