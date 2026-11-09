import type { ZodError, ZodType } from "zod";
import { mcpError, type ToolFailure } from "../errors.js";

type Issue = ZodError["issues"][number];

/** Readable message for one issue: missing top-level arguments say "required", enums list their valid values. */
function issueMessage(i: Issue, shape?: Record<string, ZodType>, raw?: unknown): string {
  const key = i.path.length === 1 ? String(i.path[0]) : undefined;
  const args = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const values = i.code === "invalid_value" ? (i as any).values as unknown[] | undefined : undefined;
  const valid = values?.length ? `valid values: ${values.map((v) => JSON.stringify(v)).join(" | ")}` : undefined;
  if (key !== undefined && shape?.[key] && args[key] === undefined) {
    const desc = shape[key].description;
    return `\`${key}\` is required${valid ? ` (${valid})` : desc ? ` (${desc})` : ""}.`;
  }
  if (key !== undefined && valid) return `\`${key}\` must be one of the ${valid}; got ${JSON.stringify(args[key])}.`;
  return i.message;
}

export function mcpErrorFromZod(err: ZodError, shape?: Record<string, ZodType>, raw?: unknown): ToolFailure {
  const errors = err.issues.slice(0, 20).map((i) => ({ pointer: "/" + i.path.map(String).join("/"), message: issueMessage(i, shape, raw) }));
  const first = errors[0];
  return mcpError("invalid-arguments", `Invalid arguments: ${first ? `${first.pointer}: ${first.message}` : "unknown"}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`, "Fix the arguments as described and call again.", { errors });
}
