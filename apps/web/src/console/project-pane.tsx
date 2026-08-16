"use client";

import { Button } from "@/components/ui/button";
import { DOT_WORD, type ProjectAction, type ProjectViewJson } from "@/console/fleet-view.interface";
import { cn } from "@/lib/utils";

const STATE_CLASS: Record<ProjectViewJson["dot"], string> = {
  green: "text-health-green",
  amber: "text-health-amber",
  red: "text-health-red",
  gray: "text-health-gray",
};

function timeOf(iso: string | null): string {
  if (iso === null) return "-";
  const parsed = new Date(iso);
  // 24-hour, to match the daemon's own log timestamps one pane below.
  return Number.isNaN(parsed.getTime()) ? "-" : parsed.toLocaleTimeString([], { hour12: false });
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[10px] tracking-[0.18em] text-muted-foreground uppercase">{label}</dt>
      <dd className="truncate text-[13px]">{children}</dd>
    </div>
  );
}

/**
 * The selected project's header, actions, and config strip — the TUI's right
 * pane above the logs. No optimistic state anywhere: buttons reflect the last
 * poll, and an action's outcome arrives with the next one.
 */
export function ProjectPane({
  project,
  actionInFlight,
  onAction,
}: {
  readonly project: ProjectViewJson;
  readonly actionInFlight: boolean;
  readonly onAction: (action: ProjectAction) => void;
}) {
  const running = project.pid !== null;
  // The TUI's disabled-project contract: stopping a running disabled job is
  // fine, starting one is not.
  const startBlocked = !running && !project.enabled;

  return (
    <header className="flex flex-col gap-4 border-b px-6 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-lg font-semibold tracking-tight">{project.key}</h1>
        <p className={cn("text-[13px]", STATE_CLASS[project.dot])}>{DOT_WORD[project.dot]}</p>
        {running && <p className="text-[13px] text-muted-foreground">pid {project.pid}</p>}
        {project.stopping && <p className="text-[13px] text-muted-foreground">stopping…</p>}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={actionInFlight || startBlocked}
            title={startBlocked ? `'${project.key}' is disabled in config` : undefined}
            onClick={() => onAction(running ? "stop" : "start")}
          >
            {running ? "Stop" : "Start"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={actionInFlight || !project.enabled}
            onClick={() => onAction("restart")}
          >
            Restart
          </Button>
        </div>
      </div>
      <dl className="grid max-w-2xl grid-cols-2 gap-x-10 gap-y-3 sm:grid-cols-4">
        <Field label="agent">{project.resolved?.agent ?? "not resolved — run: score up"}</Field>
        <Field label="tick interval">
          {project.resolved === null ? "-" : `${project.resolved.tickIntervalMs / 1000}s`}
        </Field>
        <Field label="parallel">{project.resolved?.maxParallel ?? "-"}</Field>
        <Field label="last pass">{timeOf(project.status?.last_pass_completed_at ?? null)}</Field>
      </dl>
      {project.status?.last_error != null && (
        <p className="truncate text-[13px] text-health-red" title={project.status.last_error}>
          last error: {project.status.last_error}
        </p>
      )}
      {project.status?.last_gate_failure != null && (
        <p
          className="truncate text-[13px] text-health-amber"
          title={project.status.last_gate_failure}
        >
          gate: {project.status.last_gate_failure}
        </p>
      )}
    </header>
  );
}
