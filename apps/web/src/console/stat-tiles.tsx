"use client";

import { TONE_TEXT, type Tone } from "@/console/tone";

/**
 * The design file's stat tiles: quiet sans label, JetBrains Mono value,
 * hue only where the design assigns one (blue identity, cyan activity,
 * green landed, amber attention). Values arrive computed
 * (activity.policy); a tile never derives.
 */
export interface Stat {
  readonly label: string;
  readonly value: number | string;
  readonly tone?: Tone | "blue";
}

const VALUE_CLASS: Record<NonNullable<Stat["tone"]>, string> = {
  ...TONE_TEXT,
  blue: "text-accent-blue",
};

export function StatTiles({ stats }: { readonly stats: readonly Stat[] }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="rounded-[10px] border border-card-border bg-card px-3.5 py-3"
        >
          <p className="text-xs text-ink-dim">{stat.label}</p>
          <p
            className={`font-mono text-[22px] leading-relaxed font-medium ${stat.tone !== undefined ? VALUE_CLASS[stat.tone] : "text-foreground"}`}
          >
            {stat.value}
          </p>
        </div>
      ))}
    </div>
  );
}
