import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";
import { ClientRoots, CombinedRoots, StaticRoots, type Root, type RootsProvider } from "./fs/guard.js";
import { refreshToolDescriptions } from "./tools/common.js";
import type { Deps } from "./context.js";

export interface RootsSetup {
  provider: RootsProvider;
  /** Set when client roots are in use (local mode, SUBTITLE_MCP_USE_CLIENT_ROOTS not false). */
  client?: ClientRoots;
}

/**
 * Roots in local mode (Wauter, 2026-10-17; supersedes D-13 "configured replace client roots"): configured roots
 * (SUBTITLE_MCP_ALLOWED_DIRS / SUBTITLE_MCP_READONLY_DIRS) are COMBINED with the client's workspace roots when the
 * client supports roots and SUBTITLE_MCP_USE_CLIENT_ROOTS isn't false. The effective set is the union; client roots
 * are read-write, a configured read-only folder stays read-only inside a client root, and an empty or failing
 * roots/list never removes configured folders. Sidecar/hosted: configured roots only.
 */
export function selectRoots(cfg: Config, configured: Root[], fetcher: () => Promise<{ uri: string }[]>, log?: Logger): RootsSetup {
  if (cfg.mode === "local" && cfg.useClientRoots) {
    const client = new ClientRoots(fetcher, { log });
    return { provider: new CombinedRoots(configured, client), client };
  }
  if (configured.length) return { provider: new StaticRoots(configured) };
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

export const rootsSource = (s: RootsSetup): string => {
  const src = s.provider.snapshot().source;
  return s.client ? (src === "configured" ? "configured+client" : "client") : src;
};
