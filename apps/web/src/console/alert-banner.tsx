"use client";

import { Button } from "@/components/ui/button";
import { DOT_WORD, type ProjectViewJson } from "@/console/fleet-view.interface";
import { timeAgo } from "@/console/format";

/** A project earns a banner when it crashed or its status carries an error. */
export function troubledProjects(projects: readonly ProjectViewJson[]): readonly ProjectViewJson[] {
  return projects.filter(
    (project) => project.dot === "red" || (project.enabled && project.status?.last_error != null),
  );
}

/**
 * The mockup's alert strip: one row per troubled daemon — plain outcome
 * left, the status file's own error text in mono, actions right. Only real
 * state: no banner is ever synthesized from a guess.
 */
export function AlertBanner({
  project,
  nowMs,
  actionInFlight,
  onRestart,
  onViewJournal,
}: {
  readonly project: ProjectViewJson;
  readonly nowMs: number;
  readonly actionInFlight: boolean;
  readonly onRestart: () => void;
  readonly onViewJournal: () => void;
}) {
  const since = project.status === null ? "" : ` — ${timeAgo(project.status.updated_at, nowMs)}`;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-health-red/5 px-4 py-2.5">
      <span className="size-2 shrink-0 rounded-full bg-health-red" />
      <p className="text-[13px]">
        <span className="font-semibold">{project.key}</span> daemon {DOT_WORD[project.dot]}
        {since}
      </p>
      {project.status?.last_error != null && (
        <p
          className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground"
          title={project.status.last_error}
        >
          {project.status.last_error}
        </p>
      )}
      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onViewJournal}>
          View journal
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={actionInFlight || !project.enabled}
          onClick={onRestart}
        >
          Restart daemon
        </Button>
      </div>
    </div>
  );
}
