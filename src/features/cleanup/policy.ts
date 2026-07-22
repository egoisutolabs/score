/** Legacy reads each porcelain record's path text without interpreting renames. */
export function changedPathsFromPorcelain(status: string): readonly string[] {
  return status
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3));
}

export function cleanupStatusIsSafe(status: string, allowlist: readonly string[]): boolean {
  return changedPathsFromPorcelain(status).every((path) =>
    allowlist.some((owned) => (owned.endsWith("/") ? path.startsWith(owned) : path === owned)),
  );
}
