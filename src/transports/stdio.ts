import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import { buildDeps } from "../app.js";
import { createServer } from "../server.js";
import { discoverListing } from "../tools/storage.js";
import type { Root } from "../fs/guard.js";
import { startSweeper } from "../fs/sweep.js";
import { attachClientRoots, rootsSource, selectRoots } from "../roots.js";

export async function runStdio(cfg: Config, roots: Root[], log: Logger): Promise<void> {
  // D-13: configured roots replace client roots (roots/list is then never requested).
  const setup = selectRoots(cfg, roots, () => server.server.listRoots().then((r) => r.roots), log);
  const deps = buildDeps(cfg, { log, roots, rootsProvider: setup.provider });
  const server = createServer(deps);
  void discoverListing(deps);
  let stopSweep: (() => void) | undefined;
  if (setup.client) {
    const cr = setup.client;
    attachClientRoots(server, deps, cr, log, () => {
      stopSweep?.();
      stopSweep = cr.snapshot().roots.length ? startSweeper(cr, cfg.partialMaxAgeMs, log) : undefined;
    });
  } else if (roots.some((r) => r.writable)) {
    stopSweep = startSweeper(setup.provider, cfg.partialMaxAgeMs, log);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("listening", { transport: "stdio", rootsSource: rootsSource(setup) });
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.on("end", () => resolve());
  });
  stopSweep?.();
}
