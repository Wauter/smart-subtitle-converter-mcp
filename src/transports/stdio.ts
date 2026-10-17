import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import { buildDeps } from "../app.js";
import { createServer } from "../server.js";
import { ClientRoots, StaticRoots, type Root, type RootsProvider } from "../fs/guard.js";
import { startSweeper } from "../fs/sweep.js";

export async function runStdio(cfg: Config, roots: Root[], log: Logger): Promise<void> {
  let provider: RootsProvider;
  let clientRoots: ClientRoots | undefined;
  // D-13: configured roots replace client roots.
  if (roots.length) provider = new StaticRoots(roots);
  else if (cfg.useClientRoots) {
    clientRoots = new ClientRoots(
      () => server.server.listRoots().then((r) => r.roots),
      (e) => log.warn("roots/list failed", { error: (e as Error).message }),
    );
    provider = clientRoots;
  } else provider = new StaticRoots([], "no allowed folders are configured (SUBTITLE_MCP_USE_CLIENT_ROOTS=false)");

  const deps = buildDeps(cfg, { log, roots, rootsProvider: provider });
  const server = createServer(deps);
  let stopSweep: (() => void) | undefined;
  if (clientRoots) {
    const cr = clientRoots;
    server.server.oninitialized = () => {
      const caps = server.server.getClientCapabilities();
      if (caps?.roots) {
        cr.refresh().then(async () => {
          const r = await cr.get();
          log.info("client roots", { count: r.roots.length });
          stopSweep?.();
          if (r.roots.length) stopSweep = startSweeper(cr, cfg.partialMaxAgeMs, log);
        });
      } else cr.disable("the client does not provide workspace roots; set SUBTITLE_MCP_ALLOWED_DIRS");
    };
    server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
      await cr.refresh();
    });
  } else if (roots.some((r) => r.writable)) {
    stopSweep = startSweeper(provider, cfg.partialMaxAgeMs, log);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("listening", { transport: "stdio", rootsSource: roots.length ? "configured" : clientRoots ? "client" : "none" });
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.on("end", () => resolve());
  });
  stopSweep?.();
}
