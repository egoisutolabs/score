"use client";

// The design file's chart greens: past bars sit back, today reads bright.
// Sequential single hue (validated: contrast >= 3:1 on the card surface,
// lightness monotonic) — the --health-* tokens stay reserved for status
// even though today's green coincides.
const PAST_GREEN = "#245c40";
const TODAY_GREEN = "#3ddc84";
/** Bar area height, the design's 84px. */
const PLOT_H = 84;
/** A zero day still shows a stub — the day visibly exists. */
const STUB_H = 4;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "YYYY-MM-DD" → "Aug 3". String math, not Date — no local-zone drift. */
function formatDay(day: string): string {
  const [, month, date] = day.split("-");
  return `${MONTHS[Number(month) - 1]} ${Number(date)}`;
}

/**
 * Merges per day, the design file's layout verbatim: one flex column per
 * day — count in faint mono above, flat bar below — so every day's number
 * is readable without hover (the design labels every bar; with 14 quiet
 * single-digit labels that is density, not noise). Purely presentational:
 * the caller guarantees buckets are oldest→newest, zero-filled.
 */
export function MergeChart({
  buckets,
}: {
  readonly buckets: readonly { day: string; count: number }[];
}) {
  const count = buckets.length;
  const max = buckets.reduce((m, b) => Math.max(m, b.count), 0);
  const mid = buckets[Math.floor(count / 2)];

  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  if (count === 0 || total === 0) {
    // A wall of zero-stubs reads as breakage; collapse to one quiet line
    // until there is a merge to draw.
    return (
      <p className="text-[12.5px] text-ink-dim">
        no merges recorded yet — history builds as the daemon lands PRs
      </p>
    );
  }

  return (
    <div className="w-full">
      <div
        role="img"
        aria-label={`Merges per day over ${count} days, ${formatDay(buckets[0].day)} to today`}
      >
        <div className="flex items-end gap-1.5" style={{ height: PLOT_H + 20 }}>
          {buckets.map((bucket, index) => (
            <div
              key={bucket.day}
              title={`${formatDay(bucket.day)} — ${bucket.count} merged`}
              className="flex h-full flex-1 flex-col items-center justify-end gap-[5px]"
            >
              <span className="font-mono text-[10.5px] leading-none text-ink-faint">
                {bucket.count}
              </span>
              <div
                className="w-full rounded-t-[3px]"
                style={{
                  height:
                    max > 0 && bucket.count > 0
                      ? Math.max(STUB_H, Math.round((bucket.count / max) * PLOT_H))
                      : STUB_H,
                  background: index === count - 1 ? TODAY_GREEN : PAST_GREEN,
                }}
              />
            </div>
          ))}
        </div>
        <div className="flex justify-between pt-1.5 font-mono text-[11px] text-ink-faint">
          <span>{formatDay(buckets[0].day)}</span>
          {mid !== undefined && count > 2 && <span>{formatDay(mid.day)}</span>}
          <span>today</span>
        </div>
      </div>
      {/* role="img" flattens its subtree for AT; the real data lives here. */}
      <table className="sr-only">
        <caption>Merges per day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Merges</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((bucket) => (
            <tr key={bucket.day}>
              <th scope="row">{bucket.day}</th>
              <td>{bucket.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
