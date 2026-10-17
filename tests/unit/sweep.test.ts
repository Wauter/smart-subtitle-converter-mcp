import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sweepOnce } from "../../src/fs/sweep.js";
import { StaticRoots } from "../../src/fs/guard.js";
import { openStaging, STAGING_DIR } from "../../src/fs/write.js";
import { silentLogger } from "../../src/log.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sweep-")));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const old = (p: string) => {
  fs.writeFileSync(p, "x");
  const t = new Date(Date.now() - 2 * 3600_000);
  fs.utimesSync(p, t, t);
};

describe("orphan sweep (D-38)", () => {
  it("deletes only old matching files inside <root>/.subtitle-mcp-staging/ of read-write roots", async () => {
    const rw = path.join(tmp, "rw");
    const ro = path.join(tmp, "ro");
    const other = path.join(tmp, "other");
    const st = path.join(rw, STAGING_DIR);
    fs.mkdirSync(path.join(st, "nested"), { recursive: true });
    fs.mkdirSync(path.join(ro, STAGING_DIR), { recursive: true });
    fs.mkdirSync(path.join(rw, "user"), { recursive: true });
    fs.mkdirSync(other);
    old(path.join(st, "a.vtt.abc123.partial"));
    old(path.join(st, "b.stl.00ff00.partial"));
    fs.writeFileSync(path.join(st, "fresh.vtt.abc123.partial"), "x"); // young
    old(path.join(st, "keep.partial")); // no hex
    old(path.join(st, "x.vtt.ABC123.partial")); // uppercase hex: no match
    old(path.join(st, "nested", "n.vtt.abc123.partial")); // flat: never recursed
    old(path.join(rw, "user", "x.vtt.abc123.partial")); // user folder: never touched
    old(path.join(rw, ".a.vtt.abc123.partial")); // old-style next to target: never touched
    old(path.join(ro, STAGING_DIR, "r.vtt.abc123.partial"));
    old(path.join(other, "o.vtt.abc123.partial"));
    fs.symlinkSync(path.join(other, "o.vtt.abc123.partial"), path.join(st, "l.vtt.abc123.partial"));
    const openOne = path.join(st, "open.vtt.111111.partial");
    old(openOne);
    openStaging.add(openOne);
    const roots = new StaticRoots([
      { path: rw, writable: true },
      { path: ro, writable: false },
    ]);
    const n = await sweepOnce(roots, 3600_000, silentLogger());
    openStaging.delete(openOne);
    expect(n).toBe(2);
    expect(fs.existsSync(path.join(st, "a.vtt.abc123.partial"))).toBe(false);
    expect(fs.existsSync(path.join(st, "b.stl.00ff00.partial"))).toBe(false);
    for (const keep of [
      path.join(st, "fresh.vtt.abc123.partial"),
      path.join(st, "keep.partial"),
      path.join(st, "x.vtt.ABC123.partial"),
      path.join(st, "nested", "n.vtt.abc123.partial"),
      path.join(rw, "user", "x.vtt.abc123.partial"),
      path.join(rw, ".a.vtt.abc123.partial"),
      path.join(ro, STAGING_DIR, "r.vtt.abc123.partial"),
      path.join(other, "o.vtt.abc123.partial"),
      openOne,
    ])
      expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(st)).toBe(true); // the folder itself stays
    // No state file anywhere.
    expect(fs.readdirSync(rw).sort()).toEqual([".a.vtt.abc123.partial", STAGING_DIR, "user"]);
  });
  it("a symlinked staging folder is skipped; a missing one is fine", async () => {
    const rw = path.join(tmp, "rw");
    const other = path.join(tmp, "other");
    fs.mkdirSync(rw);
    fs.mkdirSync(other);
    old(path.join(other, "o.vtt.abc123.partial"));
    const roots = new StaticRoots([{ path: rw, writable: true }]);
    expect(await sweepOnce(roots, 1000, silentLogger())).toBe(0);
    fs.symlinkSync(other, path.join(rw, STAGING_DIR));
    expect(await sweepOnce(roots, 1000, silentLogger())).toBe(0);
    expect(fs.existsSync(path.join(other, "o.vtt.abc123.partial"))).toBe(true);
  });
  it("D-44: stale batch folders <dirname>.<6hex>.partial/ are removed whole; fresh, open and symlinked ones stay", async () => {
    const rw = path.join(tmp, "rw");
    const st = path.join(rw, STAGING_DIR);
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "precious.vtt"), "x");
    const mk = (name: string, age: number) => {
      const d = path.join(st, name);
      fs.mkdirSync(path.join(d, "s1"), { recursive: true });
      fs.writeFileSync(path.join(d, "s1", "a.vtt"), "x");
      fs.symlinkSync(outside, path.join(d, "link")); // rm must not follow it
      const t = new Date(Date.now() - age);
      fs.utimesSync(d, t, t);
      return d;
    };
    const stale = mk("out.abc123.partial", 2 * 3600_000);
    const fresh = mk("live.abc123.partial", 1000); // mtime refreshed after each chunk
    const open = mk("open.abc123.partial", 2 * 3600_000);
    fs.symlinkSync(outside, path.join(st, "evil.abc123.partial"));
    openStaging.add(open);
    const n = await sweepOnce(new StaticRoots([{ path: rw, writable: true }]), 3600_000, silentLogger());
    openStaging.delete(open);
    expect(n).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(open)).toBe(true);
    expect(fs.existsSync(path.join(outside, "precious.vtt"))).toBe(true);
    expect(fs.lstatSync(path.join(st, "evil.abc123.partial")).isSymbolicLink()).toBe(true);
  });
  it("uses the injected clock for age", async () => {
    const rw = path.join(tmp, "rw");
    fs.mkdirSync(path.join(rw, STAGING_DIR), { recursive: true });
    fs.writeFileSync(path.join(rw, STAGING_DIR, "a.vtt.abc123.partial"), "x");
    const roots = new StaticRoots([{ path: rw, writable: true }]);
    expect(await sweepOnce(roots, 1000, silentLogger(), () => Date.now())).toBe(0);
    expect(await sweepOnce(roots, 1000, silentLogger(), () => Date.now() + 5000)).toBe(1);
  });
});
