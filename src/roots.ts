import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";
import { ClientRoots, StaticRoots, type Root, type RootsProvider } from "./fs/guard.js";
import { refreshToolDescriptions } from "./tools/common.js";
import type { Deps } from "./context.js";

export interface RootsSetup {
  provider: RootsProvider;
  /** Set only when client roots are in use (local mode, nothing configured, SUBTITLE_MCP_USE_CLIENT_ROOTS). */
  client?: ClientRoots;
}

/**
 * §11.1 / D-13: configured roots (SUBTITLE_MCP_ALLOWED_DIRS / SUBTITLE_MCP_READONLY_DIRS) are authoritative and
 * replace client roots: when any are configured, roots/list is never requested, so an empty or failing client
 * answer can't touch them. Client roots are used only when nothing is configured.
 */
export function selectRoots(cfg: Config, configured: Root[], fetcher: () => Promise<{ uri: string }[]>, log?: Logger): RootsSetup {
  if (configured.length) return { provider: new StaticRoots(configured) };
  if (cfg.mode === "local" && cfg.useClientRoots) {
    const client = new ClientRoots(fetcher, { log });
    return { provider: client, client };
  }
  return { provider: new StaticRoots([], cfg.mode === "local" ? "no allowed folders are configured (SUBTITLE_MCP_USE_CLIENT_ROOTS=false)" : "no folders are mounted and allowlisted") };
}

/**
 * Wires client roots to a server: roots/list after `initialized`, again on notifications/roots/list_changed. After
 * every change the path tools' descriptions are rebuilt and notifications/tools/list_changed is sent.
 */
export function attachClientRoots(server: McpServer, deps: Deps, client: ClientRoots, log: Logger, onChange?: () => void): { settled: () => Promise<void> } {
  let chain: Promise<void> = Promise.resolve();
  const after = (changed: boolean) => {
    if (refreshToolDescriptions(server, deps) || changed) onChange?.();
  };
  const run = (fn: () => Promise<void>) => {
    chain = chain.then(fn).catch((e) => log.warn("client roots update failed", { error: (e as Error).message }));
    return chain;
  };
  server.server.oninitialized = () => {
    const caps = server.server.getClientCapabilities();
    if (caps?.roots) void run(async () => after(await client.refresh()));
    else {
      client.disable("the client doesn't provide workspace roots");
      log.info("client roots", { count: 0, reason: "the client doesn't declare the roots capability" });
      after(true);
    }
  };
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    await run(async () => after(await client.refresh()));
  });
  return { settled: () => chain };
}

export const rootsSource = (s: RootsSetup): "configured" | "client" | "none" => (s.client ? "client" : s.provider.snapshot().source);
