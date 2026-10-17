import type { ZodError } from "zod";
import { mcpError, type ToolFailure } from "../errors.js";

export function mcpErrorFromZod(err: ZodError): ToolFailure {
  const errors = err.issues.slice(0, 20).map((i) => ({ pointer: "/" + i.path.map(String).join("/"), message: i.message }));
  const first = errors[0];
  return mcpError("invalid-arguments", `Invalid arguments: ${first ? `${first.pointer}: ${first.message}` : "unknown"}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`, "Fix the arguments as described and call again.", { errors });
}
