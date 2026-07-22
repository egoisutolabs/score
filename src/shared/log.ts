import { color } from "@/shared/color";

export type LogLevel = "info" | "warn" | "debug";

export interface LogLine {
  readonly level: LogLevel;
  readonly text: string;
}

export interface Logger {
  info(text: string): void;
  warn(text: string): void;
  debug(text: string): void;
  lines(lines: readonly LogLine[]): void;
}

const LEVEL_COLOR: Record<LogLevel, (text: string) => string> = {
  info: color.blue,
  warn: color.yellow,
  debug: color.gray,
};

/** Legacy log format: ISO timestamp + level, debug gated behind --verbose. Colored on a TTY. */
export function createLogger(verbose: boolean): Logger {
  const emit = (level: LogLevel, text: string) => {
    if (level === "debug" && !verbose) return;
    const stamp = color.gray(`[${new Date().toISOString()}]`);
    const tag = LEVEL_COLOR[level](`[${level}]`);
    // Tint the whole line for warn/debug so it reads as a block; info keeps default body.
    const body =
      level === "warn" ? color.yellow(text) : level === "debug" ? color.gray(text) : text;
    console.log(`${stamp} ${tag} ${body}`);
  };
  return {
    info: (text) => emit("info", text),
    warn: (text) => emit("warn", text),
    debug: (text) => emit("debug", text),
    lines: (lines) => {
      for (const line of lines) emit(line.level, line.text);
    },
  };
}
