import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { Deps } from "./context.js";
import { ToolFailure } from "./errors.js";
import { newCallId } from "./ids.js";
import { newStats, type CallCtx } from "./api/client.js";

function toMcpError(e: unknown): never {
  if (e instanceof ToolFailure) throw new McpError(ErrorCode.InternalError, `${e.toolError.code}: ${e.toolError.detail ?? ""}`, e.toolError);
  throw e;
}

export function registerResources(server: McpServer, deps: Deps): void {
  const ctx = (extra: any): CallCtx => ({ requestId: newCallId(), stats: newStats(), signal: extra?.signal });

  server.registerResource(
    "profile-schema",
    "subtitleedit://schemas/profile.json",
    { title: "Profile JSON Schema", description: "JSON Schema 2020-12 for conversion profiles (fetched from the API on every read).", mimeType: "application/schema+json" },
    async (uri, extra) => {
      try {
        const res = await deps.api.request({ method: "GET", path: "/v1/schemas/profile.json", kind: "metadata" }, ctx(extra));
        return { contents: [{ uri: uri.href, mimeType: "application/schema+json", text: JSON.stringify(res.json, null, 2) }] };
      } catch (e) {
        toMcpError(e);
      }
    },
  );

  server.registerResource(
    "formats",
    "subtitleedit://formats",
    { title: "Format catalogue", description: "Every text and binary format the API knows, as the API returns it.", mimeType: "application/json" },
    async (uri, extra) => {
      try {
        const res = await deps.api.request({ method: "GET", path: "/v1/formats", kind: "metadata", query: { kind: "text,binary" } }, ctx(extra));
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(res.json, null, 2) }] };
      } catch (e) {
        toMcpError(e);
      }
    },
  );

  server.registerResource(
    "limits",
    "subtitleedit://limits",
    { title: "API limits", description: "Effective limits of the converter API (upload, JSON body, zip, queue, timeouts).", mimeType: "application/json" },
    async (uri, extra) => {
      const st = await deps.limits.get(ctx(extra));
      if (st.kind === "unsupported") throw new McpError(ErrorCode.InternalError, "limits endpoint not available on this API version", { source: "mcp", code: "not-supported" });
      if (st.kind === "unknown") throw new McpError(ErrorCode.InternalError, "the API limits could not be read (API unreachable or unauthorized)", { source: "mcp", code: "api-unreachable" });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(st.limits.raw, null, 2) }] };
    },
  );
}
