/**
 * Text returned to the model (get_job_file, inline convert_subtitle): capped at inlineTextMaxBytes UTF-8 bytes and cut
 * at a cue (SRT) or line boundary, never inside a UTF-8 sequence, with fields saying how much was returned.
 */
export interface TextView {
  text: string;
  truncated: boolean;
  returnedBytes: number;
  totalBytes: number;
  returnedCues?: number;
  totalCues?: number;
}

const SRT_TIMING = /^[ \t]*\d+:\d{2}:\d{2}[,.]\d{1,3}[ \t]*-->/gm;

/** Number of SRT cues, counted by their timing lines. */
export function countSrtCues(text: string): number {
  return text.match(SRT_TIMING)?.length ?? 0;
}

/** Largest prefix of `buf` that is at most `max` bytes and ends on a UTF-8 character boundary. */
function utf8Prefix(buf: Buffer, max: number): string {
  let end = Math.min(max, buf.length);
  // Step back over continuation bytes so the character starting at `end` is not split.
  while (end > 0 && end < buf.length && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/** Cuts after the last cue separator (blank line) for SRT, else after the last full line. */
function cutAtBoundary(prefix: string, srt: boolean): string {
  if (srt) {
    const m = [...prefix.matchAll(/\r?\n[ \t]*\r?\n/g)].pop();
    if (m && m.index !== undefined) return prefix.slice(0, m.index + m[0].length);
  }
  const nl = prefix.lastIndexOf("\n");
  return nl >= 0 ? prefix.slice(0, nl + 1) : prefix;
}

export function textView(text: string, maxBytes: number, srt: boolean): TextView {
  const buf = Buffer.from(text, "utf8");
  const totalBytes = buf.length;
  const cues = srt ? { totalCues: countSrtCues(text) } : {};
  if (totalBytes <= maxBytes) return { text, truncated: false, returnedBytes: totalBytes, totalBytes, ...(srt ? { returnedCues: cues.totalCues } : {}), ...cues };
  const cut = cutAtBoundary(utf8Prefix(buf, maxBytes), srt);
  return {
    text: cut, truncated: true, returnedBytes: Buffer.byteLength(cut, "utf8"), totalBytes,
    ...(srt ? { returnedCues: countSrtCues(cut) } : {}), ...cues,
  };
}

/** One summary sentence for a truncated view, e.g. "Text truncated: returned 65,431 of 812,004 bytes (cues 1–402 of 5,020)." */
export function truncationText(v: TextView, limitName = "SUBTITLE_MCP_INLINE_TEXT_MAX_BYTES"): string {
  if (!v.truncated) return "";
  const cues = v.totalCues !== undefined ? ` (cues 1–${v.returnedCues} of ${v.totalCues})` : "";
  return ` TEXT TRUNCATED: returned the first ${v.returnedBytes} of ${v.totalBytes} bytes${cues}, cut at the last whole ${v.totalCues !== undefined ? "cue" : "line"} before the ${limitName} limit; the rest is not shown.`;
}

/** Last path segment of an API location (bare path, file:, s3: or https: URI), decoded; undefined if none. */
export function locationBaseName(location: string): string | undefined {
  let pathname: string;
  if (location.startsWith("/")) pathname = location;
  else {
    try { pathname = new URL(location).pathname; } catch { return undefined; }
  }
  const last = pathname.split("/").pop();
  if (!last) return undefined;
  try { return decodeURIComponent(last); } catch { return last; }
}
