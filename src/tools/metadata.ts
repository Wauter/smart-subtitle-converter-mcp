import { featureMismatch } from "../probe.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../context.js";
import { defineTool, fieldErrors, FieldError } from "./common.js";
import { toInt } from "../api/coerce.js";

const RO = { readOnlyHint: true, idempotentHint: true } as const;

export function registerMetadataTools(server: McpServer, deps: Deps): void {
  const hosted = deps.cfg.mode === "hosted";

  defineTool(server, deps, {
    name: "list_formats",
    title: "List subtitle formats",
    description:
      "List subtitle formats the converter can read and write. Use it to find the format id or alias to pass as `target` (or `profile.source.format`). By default it lists only text formats (SRT, WebVTT, ASS, TTML, …). Set `includeBinary: true` for binary broadcast formats such as EBU STL, PAC, Cavena 890 and CapMaker Plus. Use `query` to filter by name, id or extension (e.g. \"stl\", \"vtt\"). Set `writableOnly: true` when you are choosing a conversion target. Formats with `lossy: true` may drop characters or timing precision. `options` names the `profile.formatOptions` block for format-specific settings.",
    shape: {
      query: z.string().max(100).optional().describe("Filter by name, id, alias or extension"),
      includeBinary: z.boolean().default(false).describe("Also list binary broadcast formats (EBU STL, PAC, …)"),
      writableOnly: z.boolean().default(false).describe("Only formats that can be a conversion target"),
      limit: z.number().int().min(1).max(500).default(50),
    },
    output: {
      formats: z.array(
        z.object({
          id: z.string(), name: z.string(), aliases: z.array(z.string()), extension: z.string(),
          kind: z.enum(["text", "binary", "image", "container"]),
          canRead: z.boolean(), canWrite: z.boolean(),
          lossy: z.boolean().optional(), options: z.string().nullish(),
        }),
      ),
      total: z.number().int(),
      truncated: z.boolean(),
    },
    annotations: RO,
    handler: async (a, call) => {
      const res = await deps.api.request(
        { method: "GET", path: "/v1/formats", kind: "metadata", query: { q: a.query, kind: a.includeBinary ? "text,binary" : undefined, writable: a.writableOnly ? "true" : undefined } },
        call,
      );
      const items: any[] = Array.isArray(res.json) ? res.json : [];
      // D-36 feature sanity check: items without `kind` mean a non-target API; warn and treat them as text.
      if (items.some((i) => typeof i?.kind !== "string")) featureMismatch(deps.log, "format items without `kind`");
      let formats = items
        .map((i) => {
          const kind = typeof i.kind === "string" ? i.kind : "text";
          const f: any = {
            id: String(i.id), name: String(i.name), aliases: Array.isArray(i.aliases) ? i.aliases.map(String) : [], extension: String(i.extension ?? ""),
            kind, canRead: !!i.canRead, canWrite: !!i.canWrite,
          };
          if (typeof i.lossy === "boolean") f.lossy = i.lossy;
          if (i.options !== undefined) f.options = i.options;
          return f;
        })
        .filter((f) => ["text", "binary", "image", "container"].includes(f.kind));
      if (!a.includeBinary) formats = formats.filter((f) => f.kind === "text");
      if (a.writableOnly) formats = formats.filter((f) => f.canWrite);
      const total = formats.length;
      const shown = formats.slice(0, a.limit);
      const head = total === 0 ? `No formats${a.query ? ` matching '${a.query}'` : ""}. Try a broader query${a.includeBinary ? "" : " or includeBinary: true"}.` : `${total} format${total === 1 ? "" : "s"}${a.query ? ` matching '${a.query}'` : ""}${total > shown.length ? ` (showing ${shown.length})` : ""}:`;
      const lines = shown.map((f) => `${f.id} | ${f.name} (${f.extension}) | ${f.kind} | ${f.canRead && f.canWrite ? "read/write" : f.canRead ? "read-only" : "write-only"}${f.lossy ? " | lossy" : ""}`);
      const summary = [head, ...lines].join("\n");
      return { structured: { formats: shown, total, truncated: total > shown.length }, summary };
    },
  });

  const presetShape = z.object({
    name: z.string(), origin: z.string(), valid: z.boolean(), description: z.string().nullish(), target: z.string().nullish(),
    shadows: z.string().nullish(), path: z.string().nullish(), errors: z.array(FieldError).optional(), warnings: z.array(FieldError).optional(),
  });

  defineTool(server, deps, {
    name: "list_presets",
    title: "List conversion presets",
    description:
      "List the conversion presets available on this server: built-in ones plus any the operator mounted. Each preset fixes a target format and a set of clean-up operations (e.g. \"netflix-en-vtt\"). Pass a preset `name` as `preset` to convert_subtitle or convert_batch. Invalid presets are listed too, with `valid: false` and errors, so you can explain why one can't be used. Use get_profile to see what a preset does.",
    shape: {},
    output: { presets: z.array(presetShape), profilesDir: z.string().nullish(), mountError: z.string().nullish() },
    annotations: RO,
    handler: async (_a, call) => {
      const res = await deps.api.request({ method: "GET", path: "/v1/profiles", kind: "metadata" }, call);
      const body: any = res.json ?? {};
      const list: any[] = Array.isArray(body) ? body : Array.isArray(body.profiles) ? body.profiles : [];
      const presets = list.map((p) => {
        const o: any = { name: String(p.name), origin: String(p.origin ?? ""), valid: !!p.valid, description: p.description ?? null, target: p.target ?? null, shadows: p.shadows ?? null };
        if (!hosted) o.path = p.path ?? null;
        const errs = fieldErrors(p.errors);
        const warns = fieldErrors(p.warnings);
        if (errs.length) o.errors = errs;
        if (warns.length) o.warnings = warns;
        return o;
      });
      const structured: any = { presets, mountError: body.mountError ?? null };
      if (!hosted) structured.profilesDir = body.profilesDir ?? null;
      const lines = presets.map((p) => `${p.name} → ${p.target ?? "?"} (${p.origin})${p.valid ? "" : ` INVALID: ${p.errors?.[0]?.message ?? "see errors"}`}`);
      let summary = presets.length ? lines.join("\n") : "No presets on this server.";
      if (body.mountError) summary = `Mounted presets folder problem: ${body.mountError}\n${summary}`;
      return { structured, summary };
    },
  });

  defineTool(server, deps, {
    name: "get_profile",
    title: "Show a preset",
    description:
      "Show one preset in full: its raw JSON, the resolved profile (with `extends` flattened) that a conversion would actually use, and any load errors or warnings. Use it to explain what a preset does, or as a starting point for a custom `profile` (copy `resolved` and change it, then check it with validate_profile).",
    shape: { name: z.string().min(1).max(200) },
    output: {
      name: z.string(), origin: z.string(), valid: z.boolean(), description: z.string().nullish(), target: z.string().nullish(), shadows: z.string().nullish(),
      path: z.string().nullish(), errors: z.array(FieldError), warnings: z.array(FieldError), raw: z.record(z.unknown()).nullable(), resolved: z.record(z.unknown()).nullable(),
    },
    annotations: RO,
    handler: async (a, call) => {
      const res = await deps.api.request({ method: "GET", path: `/v1/profiles/${encodeURIComponent(a.name)}`, kind: "metadata" }, call);
      const p: any = res.json ?? {};
      const out: any = {
        name: String(p.name ?? a.name), origin: String(p.origin ?? ""), valid: !!p.valid, description: p.description ?? null, target: p.target ?? null, shadows: p.shadows ?? null,
        errors: fieldErrors(p.errors), warnings: fieldErrors(p.warnings),
        raw: p.raw && typeof p.raw === "object" ? p.raw : null, resolved: p.resolved && typeof p.resolved === "object" ? p.resolved : null,
      };
      if (!hosted) out.path = p.path ?? null;
      const ops = Array.isArray(out.resolved?.operations) ? out.resolved.operations.map((o: any) => o?.id).filter(Boolean) : null;
      let summary = `${out.name} (${out.origin}) → ${out.target ?? "no target"}, ${out.valid ? "valid" : "INVALID"}.`;
      if (ops) summary += ` Operations: ${ops.length ? ops.join(", ") : "none"}.`;
      if (out.errors.length) summary += `\nErrors: ${out.errors.map((e: any) => `${e.pointer}: ${e.message}`).join("; ")}`;
      return { structured: out, summary };
    },
  });
  void toInt;
}
