import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { ResultIn } from "./config.js";

/**
 * Builds a tool result from one object (SUBTITLE_MCP_RESULT_IN). MCP clients differ in which part they pass to the model,
 * so by default both carry the same information: `structuredContent`, and the same object serialized as JSON in a text
 * block (the spec's backwards-compatibility SHOULD). `structured` sends only structuredContent; `content` only the text
 * block (tools then declare no outputSchema). Errors always carry the JSON text block: some clients (Claude Code, the
 * OpenAI Agents SDK) give the model only the text of an isError result. Extra blocks (an attached file, a
 * resource_link) are kept in every mode.
 */
export function toolResult(mode: ResultIn, structured: Record<string, unknown>, extra: ContentBlock[] = [], isError = false): CallToolResult {
  const json: ContentBlock = { type: "text", text: JSON.stringify(structured) };
  return {
    ...(isError ? { isError: true } : {}),
    content: mode === "structured" && !isError ? [...extra] : [json, ...extra],
    ...(mode === "content" ? {} : { structuredContent: structured }),
  };
}
