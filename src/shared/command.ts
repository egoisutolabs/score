export type Command = readonly [string, ...string[]];

export interface CommandResult {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly dryRun: boolean;
}
