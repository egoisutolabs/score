"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { ProjectViewJson } from "@/console/fleet-view.interface";
import { TONE_TEXT, type Tone } from "@/console/tone";
import { cn } from "@/lib/utils";

const DOT_CLASS: Record<ProjectViewJson["dot"], string> = {
  green: "bg-health-green",
  amber: "bg-health-amber",
  red: "bg-health-red",
  gray: "bg-health-gray",
};

/** One derived status line per project, computed by the page from the fold. */
export interface RailStatus {
  readonly text: string;
  readonly tone?: Tone;
}

/**
 * The design file's project rail: card per project — dot, name, tick meta
 * right, one derived status line below. A crashed project's card carries
 * the red tint; selection carries the raised surface.
 */
export function ProjectRail({
  projects,
  statuses,
  selectedKey,
  onSelect,
}: {
  readonly projects: readonly ProjectViewJson[];
  readonly statuses: ReadonlyMap<string, RailStatus>;
  readonly selectedKey: string | null;
  readonly onSelect: (key: string) => void;
}) {
  return (
    <nav className="flex w-[220px] shrink-0 flex-col border-r" aria-label="projects">
      <p className="px-5 pt-[18px] pb-2 text-[11.5px] font-semibold tracking-[0.08em] text-ink-dim uppercase">
        Projects
      </p>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-1.5 px-3.5 pb-3">
          {projects.map((project) => {
            const selected = project.key === selectedKey;
            const status = statuses.get(project.key);
            return (
              <li key={project.key}>
                <button
                  type="button"
                  onClick={() => onSelect(project.key)}
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "flex w-full flex-col gap-[5px] rounded-lg border px-3 py-[11px] text-left",
                    "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none hover:border-ring",
                    selected
                      ? "border-ring bg-secondary"
                      : project.dot === "red"
                        ? "border-[#3a1e26] bg-[#150e11]"
                        : "border-transparent",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={cn("size-[7px] shrink-0 rounded-full", DOT_CLASS[project.dot])}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                      {project.key}
                    </span>
                    <span className="font-mono text-xs text-ink-faint">
                      t{project.status?.tick ?? "-"}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "truncate pl-4 text-[12.5px]",
                      status?.tone !== undefined ? TONE_TEXT[status.tone] : "text-ink-dim",
                    )}
                  >
                    {status?.text ?? "no status yet"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </nav>
  );
}
