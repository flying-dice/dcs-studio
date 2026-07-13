// Shared pure formatting helpers. Kept adapter-free so any core service or
// adapter can reuse them and they stay trivially testable.

/** Format a byte count as a compact, human-readable size (e.g. `1.5 GB`). One
 *  decimal place below 10 in a scaled unit, whole numbers at/above 10; caps at
 *  TB and treats zero/negative counts as `0 B`. */
export function fmtBytes(n: number): string {
  if (!n || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
