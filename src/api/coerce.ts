/** OpenAPI marks ints as integer|string; coerce numeric strings. */
export function toInt(v: unknown, def = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v.trim())) return Number(v);
  return def;
}
export function toOptInt(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = toInt(v, NaN);
  return Number.isNaN(n) ? undefined : n;
}
