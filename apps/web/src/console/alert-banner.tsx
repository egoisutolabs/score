"use client";

import { DOT_WORD, type ProjectViewJson } from "@/console/fleet-view.interface";
import { timeAgo } from "@/console/format";

/** A project earns a banner when it crashed or its status carries an error. */
export function troubledProjects(projects: readonly ProjectViewJson[]): readonly ProjectViewJson[] {
  return projects.filter(
    (project) => project.dot === "red" || (project.enabled && project.status?.last_error != null),
  );
}

/**
 * The design file's alert strip: red-tinted row — plain outcome left, the
 * status file's own error in mono, actions right (quiet View log, loud red
 * Restart). Only real state: never synthesized from a guess.
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
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-b border-[#3a1e26] bg-[#1a1013] px-7 py-2.5">
      <span className="size-2 shrink-0 rounded-full bg-health-red" />
      <p className="text-[13.5px] text-[#f0c9cd]">
        <strong className="font-semibold">{project.key}</strong> daemon {DOT_WORD[project.dot]}
        {since}
      </p>
      {project.status?.last_error != null && (
        <p
          className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-muted-foreground"
          title={project.status.last_error}
        >
          {project.status.last_error}
        </p>
      )}
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onViewJournal}
          className="rounded-md border border-[#3a1e26] px-3 py-[5px] text-[12.5px] font-medium text-[#c9a0a6] hover:border-[#5a2e3a] hover:text-[#f0c9cd] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          View journal
        </button>
        <button
          type="button"
          disabled={actionInFlight || !project.enabled}
          onClick={onRestart}
          className="rounded-md bg-health-red px-3.5 py-[5px] text-[12.5px] font-medium text-background hover:brightness-110 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Restart daemon
        </button>
      </div>
    </div>
  );
}
