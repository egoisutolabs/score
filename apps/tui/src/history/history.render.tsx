import { Box, Text } from "ink";
import type { GitHubMerge, HistoryEvent } from "./history.interface";
import { historyOverview } from "./history.policy";

export interface HistoryColors {
  readonly text: string;
  readonly textSoft: string;
  readonly muted: string;
  readonly dim: string;
  readonly faint: string;
  readonly green: string;
  readonly cyan: string;
  readonly amber: string;
  readonly blue: string;
  readonly purple: string;
}

export interface HistoryViewProps {
  readonly events: readonly HistoryEvent[];
  readonly githubMerges: readonly GitHubMerge[];
  readonly projects: readonly string[];
  readonly day: string;
  readonly days: 7 | 30;
  readonly rows: number;
  readonly colors: HistoryColors;
}

const BLOCKS = ["·", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

function shortDay(day: string): string {
  const instant = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isNaN(instant)
    ? day
    : new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(instant);
}

function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

/** Terminal-native version of the HTML history overview over GitHub merge facts. */
export function HistoryView({
  events,
  githubMerges,
  projects,
  day,
  days,
  rows,
  colors,
}: HistoryViewProps) {
  const overview = historyOverview(events, projects, day, days, githubMerges);
  const max = Math.max(...overview.mergesByDay);
  const width = days === 7 ? 3 : 1;
  const gap = days === 7 ? " " : "";
  const chart = overview.mergesByDay
    .map((count) => {
      const block = count === 0 || max === 0 ? BLOCKS[0] : BLOCKS[Math.ceil((count / max) * 8)];
      return (block ?? BLOCKS[0]).repeat(width);
    })
    .join(gap);
  const chartLabels = `${shortDay(overview.startDay)}${" ".repeat(
    Math.max(1, chart.length - shortDay(overview.startDay).length - 5),
  )}today`;
  const rowCapacity = Math.max(2, rows - 13);
  const projectColors = [colors.green, colors.cyan, colors.blue, colors.purple] as const;

  return (
    <Box flexGrow={1} minHeight={0} paddingX={2} paddingTop={1} flexDirection="column">
      <Box height={2} alignItems="center" justifyContent="space-between">
        <Text>
          <Text bold color={colors.text}>
            HISTORY
          </Text>
          <Text
            color={colors.dim}
          >{` / ${days}d / ${shortDay(overview.startDay)} — ${shortDay(overview.endDay)}`}</Text>
        </Text>
        <Text>
          <Text color={days === 7 ? colors.text : colors.faint}>7 7d</Text>
          <Text color={colors.dim}>{"   "}</Text>
          <Text color={days === 30 ? colors.text : colors.faint}>3 30d</Text>
        </Text>
      </Box>

      <Box height={2} alignItems="center" justifyContent="space-between">
        <Text>
          <Text color={colors.green}>◆ </Text>
          <Text color={colors.dim}>MERGED </Text>
          <Text bold color={overview.merged > 0 ? colors.green : colors.faint}>
            {overview.merged}
          </Text>
        </Text>
        <Text>
          <Text color={colors.cyan}>◆ </Text>
          <Text color={colors.dim}>ACTIVE </Text>
          <Text color={colors.textSoft}>{overview.activeProjects}</Text>
          <Text color={colors.faint}>{`/${overview.byProject.length}`}</Text>
        </Text>
        <Text>
          <Text color={colors.amber}>◆ </Text>
          <Text color={colors.dim}>BUSIEST </Text>
          <Text color={colors.textSoft}>{overview.busiestDay}</Text>
          <Text color={colors.faint}>/day</Text>
        </Text>
        <Text>
          <Text color={colors.purple}>◆ </Text>
          <Text color={colors.dim}>LATEST </Text>
          <Text color={colors.textSoft}>
            {overview.latestTs === null ? "—" : shortDay(overview.latestTs.slice(0, 10))}
          </Text>
        </Text>
      </Box>

      <Box height={4} flexDirection="column">
        <Text color={colors.textSoft}>
          MERGES / {days} DAYS <Text color={colors.faint}>GitHub · UTC</Text>
        </Text>
        <Text color={overview.merged > 0 ? colors.green : colors.faint}>{chart}</Text>
        <Text color={colors.faint}>{chartLabels}</Text>
      </Box>

      <Box flexGrow={1} minHeight={0} gap={3} overflow="hidden">
        <Box flexBasis={0} flexGrow={1} flexDirection="column" overflow="hidden">
          <Text bold color={colors.textSoft}>
            BY PROJECT
          </Text>
          <Text color={colors.faint}>{"project      merge  share latest"}</Text>
          {overview.byProject.slice(0, rowCapacity).map((row, index) => (
            <Text key={row.project} wrap="truncate-end">
              <Text color={projectColors[index % projectColors.length]}>■ </Text>
              <Text color={colors.textSoft}>{row.project.slice(0, 10).padEnd(11)}</Text>
              <Text color={colors.text}>{String(row.merged).padStart(5)}</Text>
              <Text color={colors.muted}>{percent(row.share).padStart(7)}</Text>
              <Text color={colors.muted}>
                {(row.latestTs === null ? "—" : row.latestTs.slice(5, 10)).padStart(7)}
              </Text>
            </Text>
          ))}
          {overview.byProject.length === 0 ? <Text color={colors.faint}>no projects</Text> : null}
        </Box>

        <Box flexBasis={0} flexGrow={1} flexDirection="column" overflow="hidden">
          <Text bold color={colors.textSoft}>
            RECENT MERGES
          </Text>
          <Text color={colors.faint}>{"date   project / PR       title"}</Text>
          {overview.recent.slice(0, rowCapacity).map((row) => (
            <Text key={`${row.project}:${row.pullRequest}:${row.mergedTs}`} wrap="truncate-end">
              <Text color={colors.faint}>{row.mergedTs.slice(5, 10)} </Text>
              <Text color={colors.textSoft}>{row.project}</Text>
              <Text color={colors.cyan}>{` / #${row.pullRequest}`}</Text>
              <Text color={colors.muted}>{`  ${row.title ?? "Score landing"}`}</Text>
            </Text>
          ))}
          {overview.recent.length === 0 ? (
            <Text color={colors.faint}>{`no merges observed in ${days} days`}</Text>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}
