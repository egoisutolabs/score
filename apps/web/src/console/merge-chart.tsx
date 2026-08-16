"use client";

// The validated sequential green pair against the console's dark surface:
// contrast >= 3:1 for both, lightness monotonic past → today. Deliberately
// literal hexes — the --health-* tokens are reserved for status and must
// never be borrowed as series color, even though today's green coincides.
const PAST_GREEN = "#26843b";
const TODAY_GREEN = "#3fb950";

// Geometry in viewBox units. Only the x axis stretches (the plot is a fixed
// PLOT_H px tall), so y units are real pixels: the zero stub and label
// offsets render exactly, while bar/gap widths scale with the pane.
const BAR_W = 6;
const GAP = 2;
const PITCH = BAR_W + GAP;
const PLOT_H = 96;
// Headroom above the tallest bar so its count label never clips.
const MAX_BAR_H = PLOT_H - 14;
// A zero day still shows a 2px stub — the day visibly exists.
const STUB_H = 2;
const TOP_RADIUS = 2.5;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "YYYY-MM-DD" → "Aug 3". String math, not Date — no local-zone drift. */
function formatDay(day: string): string {
  const [, month, date] = day.split("-");
  return `${MONTHS[Number(month) - 1]} ${Number(date)}`;
}

/** Rounded top corners only — the baseline edge stays square. */
function barPath(x: number, height: number): string {
  // Clamp so a stub-height or narrow bar never folds the arcs over.
  const r = Math.min(TOP_RADIUS, height, BAR_W / 2);
  const top = PLOT_H - height;
  return [
    `M${x} ${PLOT_H}`,
    `V${top + r}`,
    `Q${x} ${top} ${x + r} ${top}`,
    `H${x + BAR_W - r}`,
    `Q${x + BAR_W} ${top} ${x + BAR_W} ${top + r}`,
    `V${PLOT_H}`,
    "Z",
  ].join(" ");
}

/**
 * Merges per day as a single-series bar chart. Purely presentational: the
 * caller guarantees buckets are oldest→newest, zero-filled, one per day.
 * Single series, so no legend; identity is carried by the title above it.
 */
export function MergeChart({
  buckets,
}: {
  readonly buckets: readonly { day: string; count: number }[];
}) {
  const count = buckets.length;
  const last = count - 1;
  const max = buckets.reduce((m, b) => Math.max(m, b.count), 0);
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  // Scale only when a real max exists; an all-zero span is all stubs, and
  // guarding here is what keeps the math divide-by-zero free.
  const heights = buckets.map((b) =>
    max > 0 && b.count > 0 ? Math.max(STUB_H, (b.count / max) * MAX_BAR_H) : STUB_H,
  );

  // Selective direct labels: only the max bucket and today get a count.
  // A tie or an all-zero span collapses to today's label alone.
  const labeled = new Set<number>();
  if (count > 0) {
    labeled.add(last);
    if (max > 0) labeled.add(buckets.findIndex((b) => b.count === max));
  }

  const summary =
    count === 0
      ? "Merges per day: no days recorded"
      : count === 1
        ? `Merges per day: ${total} merged on ${formatDay(buckets[0].day)}`
        : `Merges per day: ${total} merged over ${count} days, ${formatDay(buckets[0].day)} to ${formatDay(buckets[last].day)}`;

  return (
    <div className="w-full">
      <div role="img" aria-label={summary}>
        {/* The border-b is the 1px recessive baseline; bars anchor onto it,
            and it stays visible as an empty track when there are no buckets. */}
        <div className="relative h-24 w-full border-b border-border">
          {count > 0 && (
            // aria-hidden: the role="img" wrapper carries the accessible name;
            // per-bar <title>s exist for hover tooltips, not for AT.
            <svg
              className="absolute inset-0 h-full w-full"
              viewBox={`0 0 ${count * PITCH} ${PLOT_H}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {buckets.map((bucket, index) => (
                <g key={bucket.day} className="group">
                  <title>{`${formatDay(bucket.day)} — ${bucket.count} merged`}</title>
                  <path
                    d={barPath(index * PITCH + GAP / 2, heights[index])}
                    fill={index === last ? TODAY_GREEN : PAST_GREEN}
                    className="group-hover:brightness-125"
                  />
                  {/* Full-height, full-pitch hit target so hover doesn't
                      demand landing on a thin bar or a 2px stub. */}
                  <rect x={index * PITCH} y={0} width={PITCH} height={PLOT_H} fill="transparent" />
                </g>
              ))}
            </svg>
          )}
          {/* Count labels live in HTML, not the stretched SVG, so the text
              never distorts. Text wears the muted token, never bar color. */}
          {[...labeled].map((index) => (
            <span
              key={buckets[index].day}
              className="pointer-events-none absolute -translate-x-1/2 text-[10px] text-muted-foreground tabular-nums"
              style={{
                left: `${((index + 0.5) / count) * 100}%`,
                bottom: `${heights[index] + 3}px`,
              }}
            >
              {buckets[index].count}
            </span>
          ))}
        </div>
        {count > 0 && (
          <div className="flex justify-between pt-1 text-[10px] text-muted-foreground">
            <span>{formatDay(buckets[0].day)}</span>
            {count > 1 && <span>{formatDay(buckets[last].day)}</span>}
          </div>
        )}
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
