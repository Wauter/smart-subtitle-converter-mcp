import { http, HttpResponse } from "msw";
import { unzipSync } from "fflate";
import { API, problem } from "./harness.js";

export interface FakeOpts {
  /** Entry names containing this fail with format-not-detected. */
  badMarker?: string;
  /** Additional outputs per entry (target.additional). */
  extraOutputs?: string[];
  /** Return a 422 ambiguous-batch-names with these groups. */
  ambiguous?: { groups?: string[][]; outputs?: string[] };
  /** Return 413 when a chunk has more entries than this. */
  max413Entries?: number;
  /** Fixed output name (simulates a target.fileName template without {stem}). */
  fixedName?: string;
  /** Drop this entry from the manifest silently. */
  drop?: string;
  chunks?: string[][];
}

export const fakeBatchApi = (o: FakeOpts = {}) =>
  http.post(`${API}/v1/convert/json`, async ({ request }) => {
    const body: any = await request.json();
    const files = unzipSync(Buffer.from(body.content, "base64"));
    const names = Object.keys(files);
    o.chunks?.push(names);
    if (o.max413Entries !== undefined && names.length > o.max413Entries) return problem(413, "zip-limits-exceeded");
    if (o.ambiguous) return problem(422, "ambiguous-batch-names", { groups: o.ambiguous.groups, outputs: o.ambiguous.outputs, errors: (o.ambiguous.groups ?? []).flat().map((n) => ({ pointer: n, message: "clash" })) });
    const outputs: any[] = [];
    const entries: any[] = [];
    let i = 0;
    for (const n of names) {
      if (n === o.drop) continue;
      if (o.badMarker && n.includes(o.badMarker)) {
        const err = { type: "t", title: "Format not detected", status: 422, code: "format-not-detected", detail: "No subtitle format recognised the input.", hint: "Set profile.source.format.", entry: n };
        if (body.failFast) return problem(422, "format-not-detected", { detail: `Zip entry ${i} ('${n}') failed`, entry: n, errors: [{ pointer: `/content/entries/${i}`, message: "x" }] });
        entries.push({ source: n, status: "error", outputs: [], detected: null, warnings: [], error: err });
        i++;
        continue;
      }
      const stem = n.replace(/\.[^./]+$/, "");
      const mk = (fileName: string, fmt: string) => ({ fileName, format: fmt, formatId: fmt, mediaType: "text/vtt", content: Buffer.from(`WEBVTT\n${n}\n`).toString("base64"), contentEncoding: "base64", encoding: "utf-8", cues: 1, source: n, kind: "text" });
      const outs = [mk(o.fixedName ?? `${stem}.vtt`, "webvtt"), ...(o.extraOutputs ?? []).map((f) => mk(`${stem}.${f}.vtt`, f))];
      outputs.push(...outs);
      entries.push({ source: n, status: "ok", outputs: outs.map((x) => x.fileName), detected: { format: "SubRip", id: "subrip", encoding: "utf-8", encodingConfidence: "utf8-valid", language: null, paragraphs: 1, kind: "text" }, warnings: [{ code: "op-noop", message: "nothing" }], kind: "text" });
      i++;
    }
    return HttpResponse.json({ outputs, detected: null, stats: { paragraphsIn: 1, paragraphsOut: 1, elapsedMs: 1, queueWaitMs: 0 }, warnings: [], profile: { target: { format: "webvtt" } }, entries });
  });
