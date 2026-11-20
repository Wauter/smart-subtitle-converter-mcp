import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../context.js";
import { mcpError } from "../errors.js";
import { readFileChecked } from "../fs/guard.js";
import { apiStorageDescription, DetectedOutput, defineTool, logSource, ebuSizeWarning, exactlyOne, fieldErrors, FieldError, getCaps, loadSource, refreshToolDescriptions, mapDetected, mapWarnings, requirePathsAllowed, Warning } from "./common.js";

const RO = { readOnlyHint: true, idempotentHint: true } as const;

export function registerInspectTools(server: McpServer, deps: Deps): void {
  const paths = deps.pathsInSchema;

  defineTool(server, deps, {
    name: "validate_profile",
    title: "Validate a conversion profile",
    description: () =>
      "Check a custom conversion profile without converting. Validate every profile you write before passing it to convert_subtitle. Returns `valid`, errors with JSON pointers and hints, warnings and the resolved profile. A profile without `target.format` can be valid (with a warning): it may be a base for other presets. JSON Schema: resource `subtitleedit://schemas/profile.json`." +
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
      return { structured: out };
    },
  });

  defineTool(server, deps, {
    name: "detect_format",
    warningArray: true,
    title: "Detect subtitle format",
    description: () =>
      "Identify a subtitle file's format, character encoding, language and cue count without converting it. Use it when you don't know what a file is, or before converting when its extension is missing or misleading." +
      (paths ? " Give exactly one of `path` (preferred: the file stays out of your context and binary files stay intact), inline `content` or an API `input` URI." : " Give inline `content` (base64 for binary formats) or an API `input` URI.") +
      " The API server reads API `input` on its own side; list_allowed_folders covers local paths only." + apiStorageDescription(deps) +
      " `candidates` lists alternatives when detection is ambiguous; force one in a conversion with `profile.source.format`. Text files also report `bom` and `lineEndings`, and `warnings` flag source problems by cue number. One file per call; ZIP files are refused." +
      (paths ? ` ${deps.rootsText}` : ""),
    shape: {
      input: z.string().max(16384).optional().describe("Server-side input URI (file, s3 or https); mutually exclusive with content/path"),
      content: z.string().optional().describe("Subtitle content: text, or base64 if contentEncoding is 'base64'"),
      contentEncoding: z.enum(["text", "base64"]).default("text"),
      ...(paths ? { path: z.string().optional().describe("Absolute path to the file in an allowed folder") } : {}),
      fileName: z.string().max(255).optional().describe("File name hint; its extension helps detection"),
      encoding: z.string().max(64).optional().describe("Force the input text encoding, e.g. 'windows-1252'"),
    },
    output: { ...DetectedOutput.shape, hint: z.string().optional().describe("Set when the encoding was guessed: what to do if characters look wrong"), requestId: z.string().optional(), warnings: z.array(Warning).optional() },
    annotations: RO,
    handler: async (a: any, call) => {
      requirePathsAllowed(deps, a, ["path"]);
      exactlyOne(a, paths ? ["content", "path", "input"] : ["content", "input"], "the subtitle source");
      const caps = await getCaps(deps, call);
      refreshToolDescriptions(server);
      const src = await loadSource(deps, a, caps, call);
      logSource(deps, call, src);
      const body: Record<string, unknown> = src.input !== undefined ? { input: src.input } : { content: src.content, contentEncoding: src.contentEncoding };
      if (src.fileName) body.fileName = src.fileName;
      if (a.encoding) body.encoding = a.encoding;
      const res = await deps.api.request({ method: "POST", path: "/v1/detect", kind: "conversion", json: body }, call);
      const d = mapDetected(res.json);
      if (!d) throw mcpError("api-protocol-error", "The detect response has no format.", "Report this with the requestId.", { requestId: res.requestId });
      const warnings = [...mapWarnings((res.json as any)?.warnings), ...ebuSizeWarning(src, caps)];
      const hint = d.encodingConfidence === "heuristic" ? "Encoding was guessed; if characters look wrong, convert with `profile.encoding.input` set." : undefined;
      return { structured: { ...d, ...(hint ? { hint } : {}), ...(res.requestId ? { requestId: res.requestId } : {}), ...(warnings.length ? { warnings } : {}) } };
    },
  });
}
