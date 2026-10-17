/** Strict base64 check (standard alphabet, padding, length % 4). Whitespace is not allowed. */
export function isValidBase64(s: string): boolean {
  if (s.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(s) && !/=[^=]/.test(s);
}
export function decodedBase64Length(s: string): number {
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return (s.length / 4) * 3 - pad;
}
export const base64Len = (n: number) => 4 * Math.ceil(n / 3);
