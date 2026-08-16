"use client";

import { Button } from "@/components/ui/button";
import { DOT_WORD, type ProjectViewJson } from "@/console/fleet-view.interface";

const DOT_CLASS: Record<ProjectViewJson["dot"], string> = {
  green: "bg-health-green",
  amber: "bg-health-amber",
  red: "bg-health-red",
  gray: "bg-health-gray",
};

// The state word keeps the dot's hue; "stopped" is quiet ink, not a health color.
const STATE_TEXT: Record<ProjectViewJson["dot"], string> = {
  green: "text-health-green",
  amber: "text-health-amber",
  red: "text-health-red",
  gray: "text-ink-dim",
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11.5px] text-ink-dim">{label}</span>
      <span
        className="truncate rounded border border-card-border bg-muted px-2.5 py-1.5 font-mono text-[13px]"
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * The Config tab: one read-only card per project mirroring what the daemon
 * resolved from ~/.score/config.jsonc, plus Start/Stop/Restart via the same
 * supervisor actions as the fleet view. The file is the source of truth —
 * there is deliberately no editing here, only the "edit, then score up" hint.
 */
export function ConfigPage({
  projects,
  actionInFlight,
  onAction,
}: {
  projects: readonly ProjectViewJson[];
  actionInFlight: boolean;
  onAction: (project: ProjectViewJson, action: "start" | "stop" | "restart") => void;
}) {
  if (projects.length === 0) {
    return (
      <main className="flex min-w-0 flex-1 items-center justify-center">
        <p className="text-[13px] text-muted-foreground">
          no projects — start the daemon first:{" "}
          <code className="rounded-sm bg-secondary px-1.5 py-0.5">score up</code>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-[1160px] min-w-0 flex-1 flex-col gap-[18px] overflow-y-auto px-7 py-6">
      <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-2">
        <h1 className="text-[21px] font-semibold">Config</h1>
        <span className="font-mono text-[13px] text-ink-dim">~/.score/config.jsonc</span>
        <span className="ml-auto font-mono text-[12px] text-ink-dim">
          edit the file, then run: score up
        </span>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(420px,1fr))] items-start gap-3">
        {projects.map((project) => {
          const running = project.pid !== null;
          return (
            <div
              key={project.key}
              className="overflow-hidden rounded-[10px] border border-card-border bg-card"
            >
              <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
                <span className={`size-[7px] shrink-0 rounded-full ${DOT_CLASS[project.dot]}`} />
                <span className="text-sm font-semibold">{project.key}</span>
                {project.resolved?.repo != null && (
                  <span className="truncate font-mono text-xs text-ink-dim">
                    {project.resolved.repo}
                  </span>
                )}
                <span className={`ml-auto text-[11.5px] font-semibold ${STATE_TEXT[project.dot]}`}>
                  {DOT_WORD[project.dot]}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-3.5 gap-y-2.5 px-4 py-3.5">
                <Field label="path" value={project.resolved?.mainLocation ?? "—"} />
                <Field
                  label="agent"
                  value={project.resolved?.agent ?? "not resolved — run: score up"}
                />
                <Field
                  label="tick"
                  value={
                    project.resolved !== null ? `${project.resolved.tickIntervalMs / 1000}s` : "—"
                  }
                />
                <Field
                  label="max parallel"
                  value={project.resolved !== null ? String(project.resolved.maxParallel) : "—"}
                />
                <Field label="enabled" value={project.enabled ? "yes" : "no · disabled"} />
              </div>
              <div className="flex items-center gap-2 px-4 pb-3.5">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={actionInFlight || (!running && !project.enabled)}
                  onClick={() => onAction(project, running ? "stop" : "start")}
                >
                  {running ? "Stop" : "Start"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={actionInFlight || !project.enabled}
                  onClick={() => onAction(project, "restart")}
                >
                  Restart
                </Button>
              </div>
            </div>
          );
        })}

        <div className="flex min-h-[120px] flex-col items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-card-border">
          <span className="text-sm text-ink-dim">+ add a project</span>
          <span className="font-mono text-xs text-ink-faint">
            edit ~/.score/config.jsonc, then: score up
          </span>
        </div>
      </div>
    </main>
  );
}
