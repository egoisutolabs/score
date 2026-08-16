"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { DOT_WORD, type ProjectViewJson } from "@/console/fleet-view.interface";
import { cn } from "@/lib/utils";

const DOT_CLASS: Record<ProjectViewJson["dot"], string> = {
  green: "bg-health-green",
  amber: "bg-health-amber",
  red: "bg-health-red",
  gray: "bg-health-gray",
};

/**
 * The project rail, the TUI's left column: one card per project — name, its
 * health dot, its tick. Selection renders as a cursor-block inversion; the
 * dot is the only colored pixel on an unselected card.
 */
export function ProjectRail({
  projects,
  selectedKey,
  onSelect,
}: {
  readonly projects: readonly ProjectViewJson[];
  readonly selectedKey: string | null;
  readonly onSelect: (key: string) => void;
}) {
  return (
    <nav className="flex w-60 shrink-0 flex-col border-r" aria-label="projects">
      <p className="px-4 pt-4 pb-2 text-[10px] font-medium tracking-[0.18em] text-muted-foreground uppercase">
        projects
      </p>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-1 px-2 pb-2">
          {projects.map((project) => {
            const selected = project.key === selectedKey;
            return (
              <li key={project.key}>
                <button
                  type="button"
                  onClick={() => onSelect(project.key)}
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "group flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left",
                    "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                    selected
                      ? "bg-foreground text-background"
                      : "text-foreground hover:bg-secondary",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px]">{project.key}</span>
                    <span
                      className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[project.dot])}
                      title={DOT_WORD[project.dot]}
                    />
                  </span>
                  <span
                    className={cn(
                      "text-[11px]",
                      selected ? "text-background/70" : "text-muted-foreground",
                    )}
                  >
                    tick {project.status?.tick ?? "-"}
                    {!project.enabled && " · disabled"}
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
