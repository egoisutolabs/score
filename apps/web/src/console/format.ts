/** Tiny time formatters shared across the console's panes. */

/** "20:12:41" (UTC) from an RFC 3339 timestamp — matches the journal's own clock. */
export function hms(ts: string): string {
  return ts.slice(11, 19);
}

/** "3m ago"-style relative time; coarse on purpose — the console polls anyway. */
export function timeAgo(ts: string, nowMs: number): string {
  const thenMs = Date.parse(ts);
  if (Number.isNaN(thenMs)) return "";
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}
