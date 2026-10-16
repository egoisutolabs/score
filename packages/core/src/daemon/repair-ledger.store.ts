import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { RepairLedgerSnapshot } from "@score/core/daemon/repair-ledger.service";

/**
 * One JSON file per project, written whole via tmp + rename like status.json,
 * so a death mid-write leaves the previous snapshot, never a torn one. A
 * missing file is an empty ledger; a malformed one is an error the daemon
 * reports and starts over from — silently discarding it would hide the loss.
 */
export class RepairLedgerStore {
  constructor(private readonly path: string) {}

  async read(): Promise<RepairLedgerSnapshot | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { v?: unknown }).v !== 1 ||
      typeof (parsed as { pullRequests?: unknown }).pullRequests !== "object"
    ) {
      throw new Error(`${this.path} is not a v1 repair ledger`);
    }
    return parsed as RepairLedgerSnapshot;
  }

  async write(snapshot: RepairLedgerSnapshot): Promise<void> {
    const tmp = `${this.path}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
    await rename(tmp, this.path);
  }
}
