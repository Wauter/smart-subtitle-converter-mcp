import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolError } from "./errors.js";
import type { ResultIn } from "./config.js";
import { toolResult } from "./result.js";

/**
 * "Not configured" mode (stdio only): a recoverable configuration problem (API URL, API key file, allowed folders,
 * a mistyped setting) no longer makes the process exit before the handshake, where MCP clients show only "failed".
 * The server starts, the problem and its fix are in the server instructions, and every tool call returns
 * `mcp-misconfigured` with the same text. Nothing secret is ever part of the message.
 */
export interface Misconfig { problem: string; fix: string }

/** The tools a configured server registers (default settings); kept in step by a test. */
export const TOOL_NAMES = ["list_formats", "list_presets", "get_profile", "validate_profile", "detect_format", "convert_subtitle", "preview_text", "list_allowed_folders", "list_files"] as const;

const RESTART = " Then restart this MCP server (Claude Code: /mcp, then reconnect; other clients: restart or reload the server).";

export function misconfiguredError(m: Misconfig): ToolError {
  return { source: "mcp", code: "mcp-misconfigured", detail: `This MCP server is not configured, so no tool can run: ${m.problem}`, hint: m.fix + RESTART };
}

export function misconfiguredInstructions(m: Misconfig): string {
  return `NOT CONFIGURED: this subtitle converter MCP server started without a working configuration, so every tool returns mcp-misconfigured. Problem: ${m.problem} Fix: ${m.fix}${RESTART} Tell the user this before trying any tool.`;
}

export function createMisconfiguredServer(m: Misconfig, version: string, resultIn: ResultIn = "both"): McpServer {
  const server = new McpServer(
    { name: "smart-subtitle-converter-mcp", title: "Smart Subtitle Converter MCP (not configured)", version },
    { capabilities: { tools: {} }, instructions: misconfiguredInstructions(m) },
  );
  const error = misconfiguredError(m);
  const result = () => toolResult(resultIn, { error }, [], true);
  for (const name of TOOL_NAMES)
    server.registerTool(name, { title: name, description: `Unavailable: this MCP server is not configured (${m.problem}) Every call returns mcp-misconfigured with the fix.` }, result);
  return server;
}

/** The fix for a startup problem message (ConfigError or allowed-folder error). */
export function fixFor(message: string): string {
  if (/not both/.test(message)) return "Keep only one of SUBTITLE_API_KEY and SUBTITLE_API_KEY_FILE in this server's environment.";
  if (/SUBTITLE_API_KEY_FILE/.test(message))
    return "Point SUBTITLE_API_KEY_FILE at a file your user can read that holds the API key: copy the first key from the API's api_keys.txt, e.g. `sudo grep -v -e '^#' -e '^$' api_keys.txt | head -n 1 > ~/subtitle-api-key.txt && chmod 600 ~/subtitle-api-key.txt`, or set SUBTITLE_API_KEY instead.";
  if (/SUBTITLE_API_URL/.test(message)) return "Set SUBTITLE_API_URL to the converter API's base URL without a path, query or fragment, e.g. http://localhost:8080 (the host port the API publishes).";
  if (/allowed folder/.test(message)) return "Fix SUBTITLE_MCP_ALLOWED_DIRS / SUBTITLE_MCP_READONLY_DIRS (or --allow-dir / --allow-dir-ro): each entry must be an absolute path to an existing folder, separated by ':' (';' on Windows) or as a JSON array.";
  if (/SUBTITLE_MCP_RESULT_IN/.test(message)) return "Set SUBTITLE_MCP_RESULT_IN to both (the default), structured or content, or remove it.";
  if (/unknown environment variable/.test(message)) return "Check the spelling against docs/configuration.md, or remove the variable from this server's environment.";
  return "Correct this setting in this server's environment (Claude Code: `claude mcp add --env`, or the server's `env` block in the MCP settings); every setting is in docs/configuration.md.";
}
