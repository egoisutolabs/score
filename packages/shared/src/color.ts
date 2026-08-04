// ponytail: ~12 lines of ANSI instead of a chalk dependency; the repo stays zero-dep.
// Respects NO_COLOR and disables when stdout is not a TTY (piped/redirected logs stay clean).
const enabled =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  process.stdout.isTTY === true;

const wrap =
  (code: number) =>
  (text: string): string =>
    enabled ? `\x1b[${code}m${text}\x1b[0m` : text;

export const color = {
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  gray: wrap(90),
};
