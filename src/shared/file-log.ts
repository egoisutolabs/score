import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { Logger, LogLevel } from "@/shared/log";

const DATED_LOG = /^(\d{4}-\d{2}-\d{2})\.log$/;

export interface FileLogger extends Logger {
  /** Called once resolved config is known; sweeps immediately and after each midnight roll. */
  enableRetention(days: number): void;
}

/**
 * File sink for managed daemons: the same lines as the console logger, never
 * colored, appended to `logsDir/YYYY-MM-DD.log` (UTC dates, matching the line
 * timestamps). A date change rolls to a new file and re-runs the retention
 * sweep. Each line opens and closes the file, so a roll never drops lines.
 */
export function createFileLogger(
  logsDir: string,
  verbose: boolean,
  now: () => Date = () => new Date(),
): FileLogger {
  mkdirSync(logsDir, { recursive: true });
  let retentionDays: number | undefined;
  let currentDate = dateStamp(now());

  const sweep = () => {
    if (retentionDays === undefined) return;
    // A file dated exactly retentionDays ago survives; strictly older is removed.
    const cutoff = dateStamp(new Date(now().getTime() - retentionDays * 86_400_000));
    for (const name of readdirSync(logsDir)) {
      const dated = DATED_LOG.exec(name)?.[1];
      if (dated !== undefined && dated < cutoff) unlinkSync(join(logsDir, name));
    }
  };

  const emit = (level: LogLevel, text: string) => {
    if (level === "debug" && !verbose) return;
    const today = dateStamp(now());
    if (today !== currentDate) {
      currentDate = today;
      sweep();
    }
    appendFileSync(
      join(logsDir, `${currentDate}.log`),
      `[${now().toISOString()}] [${level}] ${text}\n`,
    );
  };

  return {
    info: (text) => emit("info", text),
    warn: (text) => emit("warn", text),
    debug: (text) => emit("debug", text),
    lines: (lines) => {
      for (const line of lines) emit(line.level, line.text);
    },
    enableRetention: (days) => {
      retentionDays = days;
      sweep();
    },
  };
}

function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}
