import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { realFsOps, SafeWriter, stagingName, sanitizeOutputName, STAGING_RE, STAGING_DIR, type FsOps } from "../../src/fs/write.js";
import { classifyErrno, writeFailure } from "../../src/fs/writeErrors.js";
import { ToolFailure } from "../../src/errors.js";
import { silentLogger } from "../../src/log.js";

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "write-")));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const writer = (ops: Partial<FsOps> = {}, rnd?: (n: number) => Buffer) => new SafeWriter(silentLogger(), { ...realFsOps, ...ops }, rnd);
const leftovers = () => (fs.readdirSync(dir, { recursive: true }) as string[]).filter((n) => n.endsWith(".partial"));
const errCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (!(e instanceof ToolFailure)) throw e;
    return e.toolError.code;
  }
};
const data = Buffer.from("WEBVTT\n");

describe("staging names", () => {
  it("is <name>.<6hex>.partial and matches the sweep pattern", () => {
    const n = stagingName("ep1.stl", "3f9a1c");
    expect(n).toBe("ep1.stl.3f9a1c.partial");
    expect(STAGING_RE.test(n)).toBe(true);
  });
  it("shortens long names to fit 255 bytes, keeping the start", () => {
    const long = "é".repeat(200) + ".vtt";
    const n = stagingName(long, "abcdef");
    expect(Buffer.byteLength(n)).toBeLessThanOrEqual(255);
    expect(n.startsWith("éé")).toBe(true);
  });
  it("sanitises API names", () => {
    expect(sanitizeOutputName("a.vtt")).toBe("a.vtt");
    for (const bad of ["", ".", "..", "a/b.vtt", "a\\b.vtt", "a\0.vtt"]) expect(() => sanitizeOutputName(bad)).toThrow(ToolFailure);
  });
});

describe("SafeWriter", () => {
  it("writes a new file via staging, leaving nothing behind", async () => {
    const r = await writer().write({ dir, name: "a.vtt", data, ifExists: "error" });
    expect(r.action).toBe("written");
    expect(fs.readFileSync(path.join(dir, "a.vtt"), "utf8")).toBe("WEBVTT\n");
    expect(leftovers()).toEqual([]);
  });
  it("error: existing target fails, file untouched, staging removed", async () => {
    fs.writeFileSync(path.join(dir, "a.vtt"), "old");
    expect(await errCode(writer().write({ dir, name: "a.vtt", data, ifExists: "error" }))).toBe("output-exists");
    expect(fs.readFileSync(path.join(dir, "a.vtt"), "utf8")).toBe("old");
    expect(leftovers()).toEqual([]);
  });
  it("replace is one rename over the target (never unlink first) and keeps an open reader's inode", async () => {
    const target = path.join(dir, "a.vtt");
    fs.writeFileSync(target, "old");
    const reader = await fsp.open(target, "r");
    const calls: string[] = [];
    const w = writer({
      unlink: async (p) => {
        calls.push("unlink:" + path.basename(p));
        return realFsOps.unlink(p);
      },
      rename: async (a, b) => {
        calls.push("rename:" + path.basename(b));
        return realFsOps.rename(a, b);
      },
    });
    const r = await w.write({ dir, name: "a.vtt", data, ifExists: "replace" });
    expect(r.action).toBe("replaced");
    expect(calls).toEqual(["rename:a.vtt"]);
    expect((await reader.readFile()).toString()).toBe("old");
    await reader.close();
    expect(fs.readFileSync(target, "utf8")).toBe("WEBVTT\n");
  });
  it("replace on a locked target → output-locked, staging gone, old file kept", async () => {
    fs.writeFileSync(path.join(dir, "a.vtt"), "old");
    const w = writer({
      rename: async () => {
        const e: NodeJS.ErrnoException = new Error("busy");
        e.code = "EBUSY";
        throw e;
      },
    });
    expect(await errCode(w.write({ dir, name: "a.vtt", data, ifExists: "replace" }))).toBe("output-locked");
    expect(fs.readFileSync(path.join(dir, "a.vtt"), "utf8")).toBe("old");
    expect(leftovers()).toEqual([]);
  });
  it("replace is exempt from the race by construction", async () => {
    const w = writer({
      rename: async (a, b) => {
        fs.writeFileSync(b, "racer");
        return realFsOps.rename(a, b);
      },
    });
    expect((await w.write({ dir, name: "a.vtt", data, ifExists: "replace" })).path).toBe(path.join(dir, "a.vtt"));
  });
  it("falls back to lstat + rename when hard links are unsupported", async () => {
    const calls: string[] = [];
    const w = writer({
      link: async () => {
        const e: NodeJS.ErrnoException = new Error("nolink");
        e.code = "ENOTSUP";
        throw e;
      },
      rename: async (a, b) => {
        calls.push("rename");
        return realFsOps.rename(a, b);
      },
    });
    await w.write({ dir, name: "a.vtt", data, ifExists: "error" });
    expect(calls).toEqual(["rename"]);
    expect(fs.readFileSync(path.join(dir, "a.vtt"), "utf8")).toBe("WEBVTT\n");
  });
  it("staging name clash → retry with a new id; 5 clashes → staging-unavailable", async () => {
    const ids = ["aaaaaa", "aaaaaa", "bbbbbb"];
    fs.mkdirSync(path.join(dir, STAGING_DIR));
    fs.writeFileSync(path.join(dir, STAGING_DIR, "a.vtt.aaaaaa.partial"), "x");
    let i = 0;
    const w1 = writer({}, () => Buffer.from(ids[i++ % ids.length], "hex"));
    await w1.write({ dir, name: "a.vtt", data, ifExists: "error" });
    expect(fs.existsSync(path.join(dir, "a.vtt"))).toBe(true);
    const w2 = writer({}, () => Buffer.from("aaaaaa", "hex"));
    expect(await errCode(w2.write({ dir, name: "b.vtt", data, ifExists: "error" }))).toBe("ok");
    fs.writeFileSync(path.join(dir, STAGING_DIR, "c.vtt.aaaaaa.partial"), "x");
    expect(await errCode(w2.write({ dir, name: "c.vtt", data, ifExists: "error" }))).toBe("staging-unavailable");
  });
  it("never touches a source file (any policy), even via a symlink", async () => {
    const src = path.join(dir, "movie.vtt");
    fs.writeFileSync(src, "source");
    for (const p of ["error", "replace"] as const) {
      expect(await errCode(writer().write({ dir, name: "movie.vtt", data, ifExists: p, sources: new Set([src]) }))).toBe("source-overwrite-refused");
    }
    fs.symlinkSync(src, path.join(dir, "link.vtt"));
    expect(await errCode(writer().write({ dir, name: "link.vtt", data, ifExists: "replace", sources: new Set([src]) }))).toBe("source-overwrite-refused");
    expect(fs.readFileSync(src, "utf8")).toBe("source");
    expect(leftovers()).toEqual([]);
  });
  it("cancellation mid-write leaves no staging file", async () => {
    const ac = new AbortController();
    const w = writer({
      lstat: async (p) => {
        ac.abort();
        return realFsOps.lstat(p);
      },
    });
    expect(await errCode(w.write({ dir, name: "a.vtt", data, ifExists: "error", signal: ac.signal }))).toBe("cancelled");
    expect(leftovers()).toEqual([]);
    expect(fs.existsSync(path.join(dir, "a.vtt"))).toBe(false);
  });
  it("D-38: stages in <root>/.subtitle-mcp-staging/, never next to the target", async () => {
    const sub = path.join(dir, "out", "s1");
    fs.mkdirSync(sub, { recursive: true });
    const seen: string[] = [];
    const w = writer({
      open: (async (p: string, ...rest: any[]) => {
        seen.push(p);
        return (fsp.open as any)(p, ...rest);
      }) as any,
    });
    await w.write({ dir: sub, root: dir, name: "a.vtt", data, ifExists: "error" });
    expect(path.dirname(seen[0])).toBe(path.join(dir, STAGING_DIR));
    expect(fs.readdirSync(sub)).toEqual(["a.vtt"]);
    expect(fs.readdirSync(path.join(dir, STAGING_DIR))).toEqual([]);
  });
  it("uses rootOf to find the output root when none is given", async () => {
    const sub = path.join(dir, "x");
    fs.mkdirSync(sub);
    const w = writer();
    w.rootOf = async () => dir;
    await w.write({ dir: sub, name: "a.vtt", data, ifExists: "error" });
    expect(fs.existsSync(path.join(dir, STAGING_DIR))).toBe(true);
    expect(fs.existsSync(path.join(sub, STAGING_DIR))).toBe(false);
  });
  it("staging folder that can't be created → staging-unavailable with osError, nothing written", async () => {
    const w = writer({
      mkdir: async () => {
        const e: NodeJS.ErrnoException = new Error("ro");
        e.code = "EACCES";
        e.syscall = "mkdir";
        throw e;
      },
    });
    const err = await w.write({ dir, name: "a.vtt", data, ifExists: "error" }).catch((e) => e as ToolFailure);
    expect((err as ToolFailure).toolError).toMatchObject({ code: "staging-unavailable", path: path.join(dir, "a.vtt"), osError: { code: "EACCES", syscall: "mkdir" } });
    expect((err as ToolFailure).toolError.hint).toContain(`${dir}/.subtitle-mcp-staging`);
    expect(fs.existsSync(path.join(dir, "a.vtt"))).toBe(false);
  });
  it("a symlinked staging folder is refused", async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "other-"));
    fs.symlinkSync(other, path.join(dir, STAGING_DIR));
    expect(await errCode(writer().write({ dir, name: "a.vtt", data, ifExists: "error" }))).toBe("staging-unavailable");
    expect(fs.readdirSync(other)).toEqual([]);
    fs.rmSync(other, { recursive: true, force: true });
  });
  it("D-41: destination on another device than the staging folder → cross-device, nothing written, no copy", async () => {
    const sub = path.join(dir, "mnt");
    fs.mkdirSync(sub);
    const calls: string[] = [];
    const w = writer({
      stat: async (p) => {
        const st = await realFsOps.stat(p);
        if (p === sub) return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 1 });
        return st;
      },
      open: (async (p: string, ...rest: any[]) => {
        calls.push(p);
        return (fsp.open as any)(p, ...rest);
      }) as any,
    });
    const err = (await w.write({ dir: sub, root: dir, name: "a.vtt", data, ifExists: "error" }).catch((e) => e)) as ToolFailure;
    expect(err.toolError.code).toBe("cross-device");
    expect(err.toolError.hint).toMatch(/own output root/);
    expect(calls).toEqual([]);
    expect(fs.readdirSync(sub)).toEqual([]);
  });
  it("EXDEV on commit → cross-device; staging removed", async () => {
    const w = writer({
      link: async () => {
        const e: NodeJS.ErrnoException = new Error("xdev");
        e.code = "EXDEV";
        throw e;
      },
    });
    expect(await errCode(w.write({ dir, name: "a.vtt", data, ifExists: "error" }))).toBe("cross-device");
    expect(leftovers()).toEqual([]);
  });
  it.each([
    ["ENOSPC", "disk-full"],
    ["EDQUOT", "disk-full"],
    ["EACCES", "permission-denied"],
    ["EPERM", "permission-denied"],
    ["EROFS", "read-only-filesystem"],
    ["EBUSY", "output-locked"],
    ["ENAMETOOLONG", "path-too-long"],
    ["EIO", "io-error"],
    ["ESTALE", "io-error"],
    ["EWEIRD", "write-failed"],
  ])("D-35: %s while writing the staging file → %s, with path/osError/hint; staging removed", async (code, expected) => {
    const w = writer({
      open: (async (p: string, ...rest: any[]) => {
        const fh = await (fsp.open as any)(p, ...rest);
        fh.writeFile = async () => {
          const e: NodeJS.ErrnoException = new Error(code);
          e.code = code;
          e.syscall = "write";
          throw e;
        };
        return fh;
      }) as any,
    });
    const err = (await w.write({ dir, name: "ep05.stl", data, ifExists: "error" }).catch((e) => e)) as ToolFailure;
    expect(err.toolError).toMatchObject({ code: expected, path: path.join(dir, "ep05.stl"), osError: { code, syscall: "write" } });
    expect(err.toolError.detail).toContain(`Couldn't write ${path.join(dir, "ep05.stl")}`);
    expect(err.toolError.hint).toBeTruthy();
    expect(leftovers()).toEqual([]);
  });
});

describe("write-failure classification (§8.3)", () => {
  it("Windows sharing violations on an existing target are output-locked", () => {
    expect(classifyErrno("EPERM", { existingTarget: true, platform: "win32" })).toBe("output-locked");
    expect(classifyErrno("EACCES", { existingTarget: true, platform: "win32" })).toBe("output-locked");
    expect(classifyErrno("EPERM", { existingTarget: true, platform: "linux" })).toBe("permission-denied");
    expect(classifyErrno("EXDEV")).toBe("cross-device");
    expect(classifyErrno("ENOTCONN")).toBe("io-error");
  });
  it("detail names path and OS cause", () => {
    const e: NodeJS.ErrnoException = new Error("x");
    e.code = "ENOSPC";
    e.syscall = "write";
    const f = writeFailure(e, "/data/out/ep05.stl");
    expect(f.toolError.detail).toBe("Couldn't write /data/out/ep05.stl: no space left on device (ENOSPC, write).");
  });
});
