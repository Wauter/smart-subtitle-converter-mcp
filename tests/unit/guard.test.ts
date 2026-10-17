import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPathSyntax, isInside, PathGuard, StaticRoots, realpathRoots, readFileChecked } from "../../src/fs/guard.js";
import { ToolFailure } from "../../src/errors.js";

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ToolFailure ? e.toolError.code : String(e);
  }
};
const syncCode = (f: () => unknown) => {
  try {
    f();
    return "ok";
  } catch (e) {
    return e instanceof ToolFailure ? e.toolError.code : String(e);
  }
};

let tmp: string, rw: string, ro: string, outside: string, guard: PathGuard;
beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-")));
  rw = path.join(tmp, "rw");
  ro = path.join(tmp, "ro");
  outside = path.join(tmp, "outside");
  for (const d of [rw, ro, outside, path.join(rw, "sub")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(rw, "a.srt"), "x");
  fs.writeFileSync(path.join(ro, "b.srt"), "y");
  fs.writeFileSync(path.join(outside, "secret.srt"), "z");
  fs.symlinkSync(path.join(outside, "secret.srt"), path.join(rw, "escape.srt"));
  fs.symlinkSync(path.join(rw, "a.srt"), path.join(rw, "inside-link.srt"));
  fs.symlinkSync(outside, path.join(rw, "escape-dir"));
  const roots = await realpathRoots([rw], [ro]);
  guard = new PathGuard(new StaticRoots(roots));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("path syntax", () => {
  it("rejects relative, empty, NUL, too long and ~ paths", () => {
    expect(syncCode(() => checkPathSyntax("a/b.srt", { platform: "linux" }))).toBe("path-not-allowed");
    expect(syncCode(() => checkPathSyntax("", { platform: "linux" }))).toBe("path-not-allowed");
    expect(syncCode(() => checkPathSyntax("/a\0b", { platform: "linux" }))).toBe("path-not-allowed");
    expect(syncCode(() => checkPathSyntax("/" + "a".repeat(5000), { platform: "linux" }))).toBe("path-not-allowed");
    expect(syncCode(() => checkPathSyntax("~/x.srt", { platform: "linux" }))).toBe("path-not-allowed");
  });
  it("normalises .. segments", () => {
    expect(checkPathSyntax("/data/in/../out/x.srt", { platform: "linux" })).toBe("/data/out/x.srt");
  });
  it("Windows: drive and UNC ok, device namespaces and drive-relative rejected", () => {
    const w = { platform: "win32" as const };
    expect(checkPathSyntax("C:\\subs\\a.srt", w)).toBe("C:\\subs\\a.srt");
    expect(checkPathSyntax("\\\\nas\\share\\a.srt", w)).toBe("\\\\nas\\share\\a.srt");
    expect(syncCode(() => checkPathSyntax("\\\\?\\C:\\a.srt", w))).toBe("path-not-allowed");
    expect(syncCode(() => checkPathSyntax("\\\\.\\COM1", w))).toBe("path-not-allowed");
    expect(syncCode(() => checkPathSyntax("C:a.srt", w))).toBe("path-not-allowed");
    expect(syncCode(() => checkPathSyntax("a.srt", w))).toBe("path-not-allowed");
  });
});

describe("containment", () => {
  it("uses path.relative, not prefix matching", () => {
    expect(isInside("/data/in", "/data/in/x", { platform: "linux" })).toBe(true);
    expect(isInside("/data/in", "/data/in", { platform: "linux" })).toBe(true);
    expect(isInside("/data/in", "/data/inside/x", { platform: "linux" })).toBe(false);
    expect(isInside("/data/in", "/data/x", { platform: "linux" })).toBe(false);
    expect(isInside("/data/in", "/data/in/..foo", { platform: "linux" })).toBe(true);
  });
  it("is case-insensitive on Windows/macOS, case-sensitive on Linux", () => {
    expect(isInside("C:\\Subs", "c:\\subs\\a.srt", { platform: "win32" })).toBe(true);
    expect(isInside("/Users/Me/Subs", "/users/me/subs/a.srt", { platform: "darwin" })).toBe(true);
    expect(isInside("/data/In", "/data/in/a.srt", { platform: "linux" })).toBe(false);
  });
});

describe("PathGuard", () => {
  it("resolves inputs inside rw and ro roots", async () => {
    expect((await guard.resolveInputFile(path.join(rw, "a.srt"))).size).toBe(1);
    expect((await guard.resolveInputFile(path.join(ro, "b.srt"))).root.writable).toBe(false);
  });
  it("rejects traversal, symlink escapes and outside paths, echoing the caller path", async () => {
    expect(await code(guard.resolveInputFile(path.join(rw, "..", "outside", "secret.srt")))).toBe("path-not-allowed");
    expect(await code(guard.resolveInputFile(path.join(rw, "escape.srt")))).toBe("path-not-allowed");
    expect(await code(guard.resolveInputFile(path.join(rw, "escape-dir", "secret.srt")))).toBe("path-not-allowed");
    try {
      await guard.resolveInputFile(path.join(rw, "escape.srt"));
    } catch (e) {
      expect((e as ToolFailure).toolError.detail).toContain("escape.srt");
      expect((e as ToolFailure).toolError.detail).not.toContain("secret");
    }
  });
  it("allows symlinks that stay inside", async () => {
    expect((await guard.resolveInputFile(path.join(rw, "inside-link.srt"))).real).toBe(path.join(rw, "a.srt"));
  });
  it("not found and not a file", async () => {
    expect(await code(guard.resolveInputFile(path.join(rw, "nope.srt")))).toBe("path-not-found");
    expect(await code(guard.resolveInputFile(path.join(rw, "sub")))).toBe("not-a-file");
    expect(await code(guard.resolveInputFile("relative.srt"))).toBe("path-not-allowed");
  });
  it("outputs need a read-write root; missing folders are created", async () => {
    expect(await code(guard.resolveOutputDir(ro, true))).toBe("path-not-allowed");
    expect(await code(guard.resolveOutputDir(outside, true))).toBe("path-not-allowed");
    expect(await code(guard.resolveOutputDir(path.join(rw, "escape-dir", "x"), true))).toBe("path-not-allowed");
    const d = await guard.resolveOutputDir(path.join(rw, "new", "deep"), true);
    expect(fs.statSync(d).isDirectory()).toBe(true);
    const f = await guard.resolveOutputFile(path.join(rw, "out.vtt"), false);
    expect(f).toEqual({ dir: rw, name: "out.vtt", full: path.join(rw, "out.vtt") });
  });
  it("no roots → paths-disabled", async () => {
    const g = new PathGuard(new StaticRoots([], "no allowed folders"));
    expect(await code(g.resolveInputFile("/x.srt"))).toBe("paths-disabled");
  });
  it("size check happens before reading", async () => {
    expect(await code(readFileChecked(path.join(rw, "a.srt"), "/x/a.srt", { name: "cap", value: 0 }))).toBe("precheck-too-large");
  });
  it("startup: missing roots are an error", async () => {
    await expect(realpathRoots([path.join(tmp, "missing")], [])).rejects.toThrow(/does not exist/);
  });
});
