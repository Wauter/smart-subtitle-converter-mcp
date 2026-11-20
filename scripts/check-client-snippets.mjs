#!/usr/bin/env node
// Checks the client config snippets in docs/clients.md:
//  1. every ```json / ```toml / ```yaml block parses;
//  2. every server launch in those blocks (and in `claude|codex mcp add` bash blocks) starts the
//     server with exactly that command, args and env and answers tools/list via the MCP Inspector CLI.
// The published `npx -y smart-subtitle-converter-mcp` is swapped for the local build (dist/index.js),
// placeholder paths under /Users/me (each entry of a folder list too) are mapped to a temp dir, and
// client-specific fields
// (type, tools, timeouts, enabled, ...) are not emulated. Run `npm run build` first.
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import console from "node:console";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

const INSPECTOR = "@modelcontextprotocol/inspector@2.15.0";
const EXPECTED = ["list_formats", "list_presets", "get_profile", "validate_profile", "detect_format", "convert_subtitle", "get_job", "preview_text", "list_allowed_folders", "list_files"];
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const doc = readFileSync(join(root, "docs/clients.md"), "utf8");
const tmp = mkdtempSync(join(tmpdir(), "client-snippets-"));

function blocks(md) {
  const out = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)```(\w+)\s*$/.exec(lines[i]);
    if (!m) continue;
    const [indent, lang] = [m[1], m[2]];
    const body = [];
    let j = i + 1;
    for (; j < lines.length && !/^\s*```\s*$/.test(lines[j]); j++) body.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j]);
    out.push({ lang, line: i + 1, text: body.join("\n") });
    i = j;
  }
  return out;
}

function shellWords(s) {
  const words = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s.replace(/\\\n/g, " ")))) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

function launchesFrom({ lang, text }) {
  if (lang === "json") {
    const cfg = JSON.parse(text);
    return Object.entries(cfg.mcpServers ?? cfg.servers ?? {}).map(([name, s]) => ({ name, command: s.command, args: s.args ?? [], env: s.env ?? {} }));
  }
  if (lang === "toml") {
    const cfg = parseToml(text);
    return Object.entries(cfg.mcp_servers ?? {}).map(([name, s]) => ({ name, command: s.command, args: s.args ?? [], env: s.env ?? {} }));
  }
  if (lang === "yaml") {
    const cfg = parseYaml(text);
    return Object.entries(cfg.extensions ?? {}).filter(([, e]) => e.type === "stdio").map(([name, e]) => ({ name, command: e.cmd, args: e.args ?? [], env: e.envs ?? {} }));
  }
  if (lang === "bash" && /\b(claude|codex) mcp add\b/.test(text)) {
    const w = shellWords(text);
    const sep = w.indexOf("--");
    const env = {};
    let name;
    for (let i = 3; i < sep; i++) {
      if (w[i] === "--env" || w[i] === "-e") { const [k, ...v] = w[++i].split("="); env[k] = v.join("="); }
      else if (w[i] === "--transport" || w[i] === "--scope" || w[i] === "-s") i++;
      else if (!w[i].startsWith("-")) name = w[i];
    }
    return [{ name, command: w[sep + 1], args: w.slice(sep + 2), env }];
  }
  return null; // not a config snippet
}

function localise(l) {
  let { command, args } = l;
  if (command === "npx" && args.join(" ") === "-y smart-subtitle-converter-mcp") [command, args] = [process.execPath, [join(root, "dist/index.js")]];
  const env = {};
  for (const [k, v] of Object.entries(l.env)) {
    let val = String(v);
    if (val.startsWith("/Users/me/")) {
      // Folder lists use ':' in the docs (POSIX path.delimiter); map each entry and rejoin with this OS's delimiter.
      const parts = /KEY_FILE$/.test(k) ? [val] : val.split(":");
      val = parts.map((p) => {
        const local = join(tmp, p.slice("/Users/me/".length));
        if (/KEY_FILE$/.test(k)) writeFileSync(local, "placeholder-key\n");
        else mkdirSync(local, { recursive: true });
        return local;
      }).join(delimiter);
    }
    env[k] = val;
  }
  return { command, args, env };
}

let failures = 0;
let launched = 0;
for (const b of blocks(doc)) {
  const where = `clients.md:${b.line} (${b.lang})`;
  let launches;
  try { launches = launchesFrom(b); } catch (e) { console.error(`FAIL ${where}: does not parse: ${e.message}`); failures++; continue; }
  if (launches === null) continue;
  if (launches.length === 0) { console.error(`FAIL ${where}: no server entry found`); failures++; continue; }
  for (const l of launches) {
    const { command, args, env } = localise(l);
    const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    try {
      const r = spawnSync("npx", ["-y", INSPECTOR, "--cli", command, ...args, ...envArgs, "--method", "tools/list"], { encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
      if (r.status !== 0) throw new Error(r.stderr || r.error?.message || `exit ${r.status}`);
      const tools = JSON.parse(r.stdout).tools ?? [];
      const names = tools.map((t) => t.name);
      const missing = EXPECTED.filter((n) => !names.includes(n));
      const unconfigured = tools.some((t) => String(t.description).startsWith("Unavailable:"));
      if (missing.length || unconfigured) throw new Error(unconfigured ? "server started in not-configured mode" : `missing tools: ${missing.join(", ")}`);
      // Every configured folder must become a root.
      const wanted = ["SUBTITLE_MCP_ALLOWED_DIRS", "SUBTITLE_MCP_READONLY_DIRS"].reduce((n, k) => n + (env[k] ? env[k].split(delimiter).length : 0), 0);
      const start = r.stderr.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.msg === "starting");
      if (wanted && start?.roots !== wanted) throw new Error(`expected ${wanted} folders, server reports ${start?.roots}`);
      console.log(`ok   ${where} ${l.name}: ${names.length} tools${wanted ? `, ${wanted} folders` : ""}`);
      launched++;
    } catch (e) {
      console.error(`FAIL ${where} ${l.name}: ${e.stderr || e.message}`);
      failures++;
    }
  }
}
if (launched === 0 && failures === 0) { console.error("FAIL no config snippets found in docs/clients.md"); failures++; }
process.exit(failures ? 1 : 0);
