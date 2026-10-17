import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { baseHandlers, harness, mswServer, tmpDir, API } from "../helpers/harness.js";
import { buildDeps } from "../../src/app.js";
import { createServer } from "../../src/server.js";
import { defaultConfig, type Config } from "../../src/config.js";
import { createLogger } from "../../src/log.js";
import { ClientRoots, realpathRoots, rootUriToPath, type Root } from "../../src/fs/guard.js";
import { allowedFoldersText } from "../../src/fs/folders.js";
import { attachClientRoots, selectRoots } from "../../src/roots.js";

beforeAll(() => mswServer.listen({ onUnhandledFrame: "error" }));
afterAll(() => mswServer.close());
afterEach(() => mswServer.resetHandlers());

const PATH_TOOLS = ["convert_subtitle", "detect_format", "validate_profile", "convert_batch"];
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** Wires a server exactly like transports/stdio.ts, against a client that declares the roots capability. */
async function stdioLike(configured: Root[], listRoots: () => Promise<{ uri: string; name?: string }[]>, cfg: Partial<Config> = {}) {
  const logs: string[] = [];
  const log = createLogger("info", false, (l) => logs.push(l));
  const config = defaultConfig({ apiUrl: API, ...cfg });
  let rootsCalls = 0;
  const setup = selectRoots(config, configured, () => server.server.listRoots().then((r) => r.roots), log);
  const deps = buildDeps(config, { log, roots: configured, rootsProvider: setup.provider });
  const server = createServer(deps);
  if (setup.client) attachClientRoots(server, deps, setup.client, log);
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: { roots: { listChanged: true } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    rootsCalls++;
    return { roots: await listRoots() };
  });
  let toolsChanged = 0;
  let onChanged: (() => void) | undefined;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    toolsChanged++;
    onChanged?.();
  });
  const nextToolsChanged = () => new Promise<void>((resolve) => (onChanged = resolve));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const firstChange = setup.client ? nextToolsChanged() : Promise.resolve();
  await client.connect(ct);
  const descriptions = async () => Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.description ?? ""]));
  return {
    client, deps, logs, setup, firstChange, nextToolsChanged, descriptions,
    rootsCalls: () => rootsCalls,
    toolsChanged: () => toolsChanged,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("file:// root URIs (url.fileURLToPath, never scheme stripping)", () => {
  it("Windows drive letters and UNC hosts", () => {
    expect(rootUriToPath("file:///C:/x", "win32")).toBe("C:\\x");
    expect(rootUriToPath("file:///c%3A/Subs/x", "win32")).toBe("c:\\Subs\\x");
    expect(rootUriToPath("file://server/share/subs", "win32")).toBe("\\\\server\\share\\subs");
  });
  it("percent-encoding is decoded", () => {
    expect(rootUriToPath("file:///tmp/My%20Subs/%C3%A9t%C3%A9", "linux")).toBe("/tmp/My Subs/été");
    expect(rootUriToPath("file:///C:/My%20Subs", "win32")).toBe("C:\\My Subs");
    expect(rootUriToPath("file:///Users/w/a%23b", "darwin")).toBe("/Users/w/a#b");
  });
  it("other schemes and broken URIs are refused", () => {
    expect(() => rootUriToPath("https://example.com/x")).toThrow(/not a file:\/\/ URI \(https\)/);
    expect(() => rootUriToPath("not a uri")).toThrow(/not a valid URI/);
    expect(() => rootUriToPath("file:///a%2Fb", "linux")).toThrow(/not a usable file URI/);
  });
});

describe("ClientRoots", () => {
  it("resolves percent-encoded folders and logs every roots/list at info (hashed paths, skipped with reasons)", async () => {
    const base = tmpDir();
    const spaced = path.join(base, "My Subs é");
    fs.mkdirSync(spaced);
    const uri = pathToFileURL(spaced).href;
    expect(uri).toContain("My%20Subs");
    const logs: string[] = [];
    const log = createLogger("info", false, (l) => logs.push(l));
    const cr = new ClientRoots(async () => [{ uri }, { uri: pathToFileURL(path.join(base, "missing")).href }, { uri: "https://x/y" }], { log });
    expect(await cr.refresh()).toBe(true);
    expect((await cr.get()).roots).toEqual([{ path: fs.realpathSync(spaced), writable: true }]);
    const rec = JSON.parse(logs.find((l) => l.includes("client roots received"))!);
    expect(rec).toMatchObject({ level: "info", received: 3, count: 1 });
    expect(rec.roots[0]).toMatch(/^[0-9a-f]{12}/);
    expect(JSON.stringify(rec)).not.toContain("My Subs");
    expect(rec.skipped.map((s: any) => s.reason)).toEqual(["folder does not exist", "not a file:// URI (https)"]);

    // With SUBTITLE_MCP_LOG_PATHS the real paths are logged.
    const logs2: string[] = [];
    const cr2 = new ClientRoots(async () => [{ uri }], { log: createLogger("info", true, (l) => logs2.push(l)) });
    await cr2.refresh();
    expect(JSON.parse(logs2.find((l) => l.includes("client roots received"))!).roots).toEqual([fs.realpathSync(spaced)]);
  });

  it("a failing roots/list keeps the previous client roots; an empty one disables paths", async () => {
    const dir = tmpDir();
    let mode: "ok" | "fail" | "empty" = "ok";
    const cr = new ClientRoots(async () => {
      if (mode === "fail") throw new Error("boom");
      return mode === "empty" ? [] : [{ uri: pathToFileURL(dir).href }];
    });
    await cr.refresh();
    mode = "fail";
    expect(await cr.refresh()).toBe(false);
    expect((await cr.get()).roots.map((r) => r.path)).toEqual([dir]);
    mode = "empty";
    expect(await cr.refresh()).toBe(true);
    expect(await cr.get()).toMatchObject({ roots: [], source: "none", reason: "the client's roots/list is empty" });
  });
});

describe("allowed folders in tool descriptions", () => {
  it("every path tool lists the configured folders with their modes, in one format", async () => {
    mswServer.use(...baseHandlers());
    const rw = tmpDir("rw-");
    const ro = tmpDir("ro-");
    const h = await harness({}, { roots: await realpathRoots([rw], [ro]) });
    const sentence = `Allowed folders: ${rw} (read-write), ${ro} (read-only).`;
    expect(allowedFoldersText(h.deps.guard.roots.snapshot())).toBe(sentence);
    const tools = (await h.client.listTools()).tools;
    for (const name of PATH_TOOLS) expect(tools.find((t) => t.name === name)!.description!.endsWith(sentence)).toBe(true);
    for (const t of tools.filter((t) => !PATH_TOOLS.includes(t.name))) expect(t.description).not.toContain("Allowed folders");
    expect(h.client.getInstructions()).toContain(sentence);
    expect(h.client.getServerCapabilities()?.tools?.listChanged).toBe(false);
    await h.close();
  });

  it("with no folders the descriptions say so and name the settings", async () => {
    mswServer.use(...baseHandlers());
    const h = await harness();
    for (const t of (await h.client.listTools()).tools.filter((t) => PATH_TOOLS.includes(t.name))) {
      expect(t.description).toMatch(/Allowed folders: none, so file paths are disabled \(.+\)\. Ask the user to set SUBTITLE_MCP_ALLOWED_DIRS \(read-write folders\) and\/or SUBTITLE_MCP_READONLY_DIRS \(read-only folders\)/);
    }
    await h.close();
  });
});

describe("client roots never override configured folders (D-13)", () => {
  it("empty roots/list with configured dirs keeps the configured dirs (roots/list isn't even requested)", async () => {
    mswServer.use(...baseHandlers());
    const dir = tmpDir();
    const s = await stdioLike(await realpathRoots([dir], []), async () => []);
    await tick();
    await s.client.sendRootsListChanged();
    await tick();
    expect(s.rootsCalls()).toBe(0);
    expect((await s.deps.guard.roots.get()).roots).toEqual([{ path: dir, writable: true }]);
    fs.writeFileSync(path.join(dir, "a.srt"), "x");
    await expect(s.deps.guard.resolveInputFile(path.join(dir, "a.srt"))).resolves.toMatchObject({ root: { path: dir } });
    expect((await s.descriptions()).convert_subtitle).toContain(`Allowed folders: ${dir} (read-write).`);
    await s.close();
  });

  it("failing roots/list with configured dirs keeps them too", async () => {
    mswServer.use(...baseHandlers());
    const dir = tmpDir();
    const ro = tmpDir();
    const s = await stdioLike(await realpathRoots([dir], [ro]), async () => {
      throw new Error("roots unsupported");
    });
    await tick();
    await s.client.sendRootsListChanged();
    await tick();
    expect((await s.deps.guard.roots.get()).roots).toEqual([{ path: dir, writable: true }, { path: ro, writable: false }]);
    expect((await s.descriptions()).detect_format).toContain(`Allowed folders: ${dir} (read-write), ${ro} (read-only).`);
    expect(s.toolsChanged()).toBe(0);
    await s.close();
  });

  it("without configured dirs, an empty roots/list (Claude Desktop) disables paths and says how to configure them", async () => {
    mswServer.use(...baseHandlers());
    const s = await stdioLike([], async () => []);
    await s.firstChange;
    expect(s.rootsCalls()).toBe(1);
    expect((await s.descriptions()).convert_batch).toContain("Allowed folders: none, so file paths are disabled (the client's roots/list is empty). Ask the user to set SUBTITLE_MCP_ALLOWED_DIRS");
    expect(s.logs.some((l) => /"level":"info".*"msg":"client roots received".*"received":0,"count":0/.test(l))).toBe(true);
    await s.close();
  });
});

describe("client roots changes", () => {
  it("a roots change rebuilds the descriptions and sends tools/list_changed", async () => {
    mswServer.use(...baseHandlers());
    const a = tmpDir();
    const b = tmpDir();
    let current = [a];
    const s = await stdioLike([], async () => current.map((d) => ({ uri: pathToFileURL(d).href })));
    expect(s.client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    await s.firstChange;
    let d = await s.descriptions();
    for (const name of PATH_TOOLS) expect(d[name]).toContain(`Allowed folders: ${a} (read-write).`);
    const before = s.toolsChanged();

    current = [a, b];
    const changed = s.nextToolsChanged();
    await s.client.sendRootsListChanged();
    await changed;
    expect(s.toolsChanged()).toBe(before + 1);
    d = await s.descriptions();
    for (const name of PATH_TOOLS) expect(d[name]).toContain(`Allowed folders: ${a} (read-write), ${b} (read-write).`);

    // The same list again: no notification.
    await s.client.sendRootsListChanged();
    await tick();
    expect(s.toolsChanged()).toBe(before + 1);
    await s.close();
  });
});
