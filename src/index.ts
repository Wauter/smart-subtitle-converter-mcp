import { ConfigError, parseArgs, safeUrl, USAGE } from "./config.js";
import { createLogger } from "./log.js";
import { realpathRoots } from "./fs/guard.js";
import { VERSION } from "./version.js";
import { probeApi } from "./probe.js";

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2), process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
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
