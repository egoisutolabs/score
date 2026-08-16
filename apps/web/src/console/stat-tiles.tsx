"use client";

/**
 * The stat-tile row: label above, bare number below — a reading, not a
 * chart. Values arrive computed (activity.policy); a tile never derives.
 */
export interface Stat {
  readonly label: string;
  readonly value: number | string;
  /** Colors the value; reserved for states worth alarm (health discipline). */
  readonly tone?: "red" | "amber";
}

const TONE_CLASS = { red: "text-health-red", amber: "text-health-amber" } as const;

export function StatTiles({ stats }: { readonly stats: readonly Stat[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {stats.map((stat) => (
        <div key={stat.label} className="rounded-md border bg-card px-4 py-3">
          <p className="text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
            {stat.label}
          </p>
          <p
            className={`mt-1 text-2xl font-semibold tabular-nums ${stat.tone !== undefined ? TONE_CLASS[stat.tone] : ""}`}
          >
            {stat.value}
          </p>
        </div>
      ))}
    </div>
  );
}
