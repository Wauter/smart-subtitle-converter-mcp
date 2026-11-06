import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../context.js";
import { mcpError } from "../errors.js";
import { readFileChecked } from "../fs/guard.js";
import { apiStorageDescription, DetectedOutput, defineTool, ebuSizeWarning, exactlyOne, fieldErrors, FieldError, getCaps, loadSource, refreshToolDescriptions, mapDetected, mapWarnings, requirePathsAllowed, Warning, warningText } from "./common.js";

const RO = { readOnlyHint: true, idempotentHint: true } as const;

export function registerInspectTools(server: McpServer, deps: Deps): void {
  const paths = deps.pathsInSchema;

  defineTool(server, deps, {
    name: "validate_profile",
    title: "Validate a conversion profile",
    description: () =>
      "Check a custom conversion profile without converting anything. Returns `valid`, errors with JSON pointers and hints, warnings, and the resolved profile. Always validate a profile you wrote yourself before using it in convert_subtitle . The JSON Schema is available as the resource `subtitleedit://schemas/profile.json`. A profile without `target.format` can be valid (with a warning) because it may be a base for other presets." +
      (paths ? ` Give exactly one of \`profile\` or \`path\`. ${deps.rootsText}` : ""),
    shape: {
      profile: z.record(z.string(), z.unknown()).optional().describe("Profile JSON object"),
      ...(paths ? { path: z.string().optional().describe("Absolute path to a profile .json file in an allowed folder") } : {}),
    },
    output: { valid: z.boolean(), errors: z.array(FieldError), warnings: z.array(FieldError), resolved: z.record(z.string(), z.unknown()).nullable() },
    annotations: RO,
    handler: async (a: any, call) => {
      requirePathsAllowed(deps, a, ["path"]);
      const which = exactlyOne(a, paths ? ["profile", "path"] : ["profile"], "the profile to check");
      const caps = await getCaps(deps, call);
      let body: string | Buffer;
      if (which === "path") {
        const r = await deps.guard.resolveInputFile(a.path);
        body = await readFileChecked(r.real, a.path, caps.maxProfile ? { name: "maxProfileBytes", value: caps.maxProfile } : undefined);
        call.log.source = "path";
      } else {
        body = JSON.stringify(a.profile);
        if (caps.maxProfile && Buffer.byteLength(body) > caps.maxProfile)
          throw mcpError("precheck-too-large", `The profile is ${Buffer.byteLength(body)} bytes; the limit is ${caps.maxProfile}.`, "Simplify the profile.", { limit: { name: "maxProfileBytes", value: caps.maxProfile, actual: Buffer.byteLength(body) } });
        call.log.source = "inline";
      }
      const res = await deps.api.request({ method: "POST", path: "/v1/profiles/validate", kind: "conversion", raw: { body, contentType: "application/json" } }, call);
      const v: any = res.json ?? {};
      const out = { valid: !!v.valid, errors: fieldErrors(v.errors), warnings: fieldErrors(v.warnings), resolved: v.resolved && typeof v.resolved === "object" ? v.resolved : null };
      const lines = [out.valid ? "The profile is valid." : `The profile is INVALID (${out.errors.length} error${out.errors.length === 1 ? "" : "s"}):`];
      for (const e of out.errors) lines.push(`  ${e.pointer}: ${e.message}${e.hint ? ` (${e.hint})` : ""}`);
      if (out.warnings.length) lines.push(`Warnings:`, ...out.warnings.map((w) => `  ${w.pointer}: ${w.message}`));
      return { structured: out, summary: lines.join("\n") };
    },
  });

  defineTool(server, deps, {
    name: "detect_format",
    warningArray: true,
    title: "Detect subtitle format",
    description: () =>
      "Identify a subtitle file's format, character encoding, language and cue count without converting it. Use it when you don't know what a file is, or before converting when the file extension is missing or misleading." +
      (paths ? " Prefer `path` (the file stays out of your context and binary files stay intact); give exactly one of `content`, `path` or server-side `input`." : " Give content (base64 for binary) or a server-side input URI.") +
      " API input is read by the API server, not this MCP or the user's laptop unless mounted there. list_allowed_folders covers local paths only, never API input." + apiStorageDescription(deps) +
      " If detection is ambiguous, `candidates` lists alternatives, and you can force one in a conversion with `profile.source.format`. For text files it also reports `bom` and `lineEndings`, and `warnings` flag source problems by cue number (`zero-length-cue`, `source-replacement-chars` for U+FFFD already in the file). PAC and Unicode PAC (FPC) bytes look alike: without a .pac/.fpc name the API answers `ambiguous-format`; then set `profile.source.format`. ZIP files are not accepted; submit one subtitle per request." +
      (paths ? ` ${deps.rootsText}` : ""),
    shape: {
      input: z.string().max(16384).optional().describe("Server-side input URI (file, s3 or https); mutually exclusive with content/path"),
      content: z.string().optional().describe("Subtitle content: text, or base64 if contentEncoding is 'base64'"),
      contentEncoding: z.enum(["text", "base64"]).default("text"),
      ...(paths ? { path: z.string().optional().describe("Absolute path to the file in an allowed folder") } : {}),
      fileName: z.string().max(255).optional().describe("File name hint; its extension helps detection"),
      encoding: z.string().max(64).optional().describe("Force the input text encoding, e.g. 'windows-1252'"),
    },
    output: { ...DetectedOutput.shape, requestId: z.string().optional(), warnings: z.array(Warning).optional() },
    annotations: RO,
    handler: async (a: any, call) => {
      requirePathsAllowed(deps, a, ["path"]);
      exactlyOne(a, paths ? ["content", "path", "input"] : ["content", "input"], "the subtitle source");
      const caps = await getCaps(deps, call);
      refreshToolDescriptions(server);
      const src = await loadSource(deps, a, caps);
      call.log.source = src.callerPath ? "path" : "inline";
      if (src.ext) call.log.inputExt = src.ext;
      if (src.callerPath) call.log.inputHash = deps.log.p(src.callerPath);
      const body: Record<string, unknown> = src.input !== undefined ? { input: src.input } : { content: src.content, contentEncoding: src.contentEncoding };
      if (src.fileName) body.fileName = src.fileName;
      if (a.encoding) body.encoding = a.encoding;
      const res = await deps.api.request({ method: "POST", path: "/v1/detect", kind: "conversion", json: body }, call);
      const d = mapDetected(res.json);
      if (!d) throw mcpError("api-protocol-error", "The detect response has no format.", "Report this with the requestId.", { requestId: res.requestId });
      const warnings = [...mapWarnings((res.json as any)?.warnings), ...ebuSizeWarning(src, caps)];
      let summary = `${d.format} (${d.id}), ${d.encoding} (${d.encodingConfidence})${d.language ? `, ${d.language}` : ""}, ${d.paragraphs} cue${d.paragraphs === 1 ? "" : "s"}.`;
      if (d.codePage) summary += ` Code page ${d.codePage}.`;
      if (d.bom !== undefined || d.lineEndings) summary += ` ${d.bom ? "BOM" : "No BOM"}${d.lineEndings ? `, line endings ${d.lineEndings}` : ""}.`;
      if (d.candidates?.length) summary += ` Other candidates: ${d.candidates.join(", ")}.`;
      if (d.encodingConfidence === "heuristic") summary += " Encoding was guessed; if characters look wrong, convert with `profile.encoding.input` set.";
      for (const w of warnings) summary += `\nWarning ${warningText(w)}`;
      return { structured: { ...d, ...(res.requestId ? { requestId: res.requestId } : {}), ...(warnings.length ? { warnings } : {}) }, summary };
    },
  });
}
