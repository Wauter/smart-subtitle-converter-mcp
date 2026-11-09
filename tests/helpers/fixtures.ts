/**
 * Deterministic QA fixtures (no large files in the repo). Mirrors the Broadcast Tester's synthetic "long90"
 * programme: N cues with the text "QA long programme cue N", two seconds apart.
 */
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function tc(ms: number, sep: "," | "."): string {
  const h = Math.floor(ms / 3_600_000), m = Math.floor(ms / 60_000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export const LONG_CUES = 1569;
export const probe = (n: number) => `QA long programme cue ${n}`;

/** SRT with `n` cues (default 1,569, about 120 KB). Two lines per cue so cue sizes vary a little. */
export function longSrt(n = LONG_CUES, eol = "\n"): string {
  let s = "";
  for (let i = 1; i <= n; i++) {
    const start = i * 2000;
    s += `${i}${eol}${tc(start, ",")} --> ${tc(start + 1500, ",")}${eol}${probe(i)}${eol}${i % 3 === 0 ? "Second line: café, naïve, Ελληνικά" : "Second line"}${eol}${eol}`;
  }
  return s;
}

/** WebVTT with a header, a NOTE block and `n` cues. */
export function longVtt(n = LONG_CUES, eol = "\n"): string {
  let s = `WEBVTT${eol}${eol}NOTE generated QA fixture${eol}${eol}`;
  for (let i = 1; i <= n; i++) {
    const start = i * 2000;
    s += `${tc(start, ".")} --> ${tc(start + 1500, ".")}${eol}${probe(i)}${eol}${eol}`;
  }
  return s;
}

/** Number of non-overlapping occurrences of `needle` in `hay`. */
export const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;
