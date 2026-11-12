import { ConfigError, parseArgs, parseResultIn, safeUrl, USAGE, type ResultIn } from "./config.js";
import { createLogger } from "./log.js";
import { realpathRoots } from "./fs/guard.js";
import { VERSION } from "./version.js";
import { probeApi } from "./probe.js";
import { createMisconfiguredServer, fixFor } from "./misconfigured.js";

/** HTTP (sidecar) mode was asked for: configuration problems stay fatal there, so an unattended container fails loudly. */
function wantsHttp(argv: string[], env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SUBTITLE_MCP_HTTP) || /^(true|1|yes)$/i.test(env.SUBTITLE_MCP_HOSTED ?? "") || argv.some((a) => a === "--http" || a.startsWith("--http=") || a === "--hosted");
}

/** stdio with a recoverable configuration problem: finish the handshake and explain it (mcp-misconfigured) instead of exiting. */
async function notConfigured(message: string): Promise<never> {
  const m = { problem: message.endsWith(".") ? message : message + ".", fix: fixFor(message) };
  process.stderr.write(`smart-subtitle-converter-mcp: not configured: ${m.problem} Fix: ${m.fix} Starting in not-configured mode: every tool call returns mcp-misconfigured until this is fixed and the server restarted.\n`);
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const transport = new StdioServerTransport();
  let resultIn: ResultIn = "both";
  try { resultIn = parseResultIn(process.env.SUBTITLE_MCP_RESULT_IN); } catch { /* the problem being reported; keep the default */ }
  await createMisconfiguredServer(m, VERSION, resultIn).connect(transport);
  await new Promise<void>((resolve) => { transport.onclose = () => resolve(); process.stdin.on("end", () => resolve()); });
  process.exit(0);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseArgs(argv, process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      if (!wantsHttp(argv, process.env) && !argv.some((a) => ["--help", "-h", "--version", "-v"].includes(a))) return notConfigured(e.message);
      process.stderr.write(`smart-subtitle-converter-mcp: ${e.message}\n\n${USAGE}\n`);
      process.exit(2);
    }
    throw e;
  }
  if (parsed.kind === "help") {
    process.stderr.write(USAGE + "\n");
    return;
  }
  if (parsed.kind === "version") {
    process.stderr.write(VERSION + "\n");
    return;
  }
  const cfg = parsed.config;
  const log = createLogger(cfg.logLevel, cfg.logPaths);
  let roots;
  try {
    roots = await realpathRoots(cfg.allowedDirs, cfg.readonlyDirs);
  } catch (e) {
    if (!cfg.http) return notConfigured((e as Error).message);
    process.stderr.write(`smart-subtitle-converter-mcp: ${(e as Error).message}\n`);
    process.exit(2);
  }
  log.info("starting", {
    version: VERSION,
    mode: cfg.mode,
    transport: cfg.http ? "http" : "stdio",
    apiUrl: safeUrl(cfg.apiUrl),
    roots: cfg.logPaths ? roots.map((r) => `${r.path}${r.writable ? "" : " (ro)"}`) : roots.length,
    rootsSource: roots.length ? "configured" : cfg.mode === "local" && cfg.useClientRoots ? "client" : "none",
    upstreamKey: cfg.apiKey || cfg.apiKeyFile ? "configured" : "none",
    listEnabled: cfg.listEnabled,
  });
  // Never wait on the API (§10 step 2): probe in the background.
  probeApi(cfg, log);
  if (cfg.http) {
    const { startHttp } = await import("./transports/http.js");
    const h = await startHttp(cfg, roots, log);
    const stop = () => h.close().then(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } else {
    const { runStdio } = await import("./transports/stdio.js");
    await runStdio(cfg, roots, log);
    process.exit(0);
  }
}

main().catch((e) => {
  process.stderr.write(`smart-subtitle-converter-mcp: fatal: ${(e as Error)?.message ?? e}\n`);
  process.exit(1);
});
