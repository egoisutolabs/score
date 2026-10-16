import type { WorktreeProvisioner } from "@score/core/workspace-driver.interface";
import type {
  BlameSource,
  FindingLedger,
  FindingRecord,
  ReviewThreadObservation,
} from "./finding.interface";
import { classifyFinding, enclosingSymbol, findingKey, resolutionOf } from "./finding.policy";

/**
 * Turns the threads GitHub reports for a PR into keyed, classified records in
 * the ledger. Blame runs once per thread, the first time it is seen; later
 * passes only refresh resolution state. A thread GitHub no longer returns
 * (deleted) drops out of the ledger with it.
 */
export class FindingTracker {
  constructor(
    private readonly blame: BlameSource,
    private readonly ancestry: Pick<WorktreeProvisioner, "isAncestor">,
    private readonly ledger: FindingLedger,
  ) {}

  async observe(
    pullRequestNumber: number,
    threads: readonly ReviewThreadObservation[],
  ): Promise<readonly FindingRecord[]> {
    const known = new Map(
      this.ledger.findings(pullRequestNumber).map((record) => [record.threadId, record] as const),
    );
    const wave = this.ledger.waveCount(pullRequestNumber);
    const firstHead = this.ledger.firstHead(pullRequestNumber);
    const records: FindingRecord[] = [];
    for (const thread of threads) {
      const prior = known.get(thread.id);
      if (prior) {
        records.push({ ...prior, resolution: resolutionOf(thread), resolvedBy: thread.resolvedBy });
        continue;
      }
      const { origin, symbol } = await this.#locate(thread);
      const key = findingKey(origin, thread, symbol);
      const originAfterFirstHead =
        origin !== undefined && firstHead !== undefined
          ? !(await this.ancestry.isAncestor(origin, firstHead))
          : undefined;
      // Prior includes this pass's earlier threads so two reviewers raising
      // one defect in the same round read as a duplicate, not two findings.
      const priorRecords = [...known.values(), ...records];
      records.push({
        threadId: thread.id,
        key,
        path: thread.path,
        symbol,
        origin,
        author: thread.author,
        createdAt: thread.createdAt,
        class: classifyFinding(
          { key, author: thread.author, wave, originAfterFirstHead },
          priorRecords,
        ),
        wave,
        resolution: resolutionOf(thread),
        resolvedBy: thread.resolvedBy,
      });
    }
    this.ledger.recordFindings(pullRequestNumber, records);
    return records;
  }

  /** A blame or show failure degrades the key to the reviewed commit; it never fails the pass. */
  async #locate(
    thread: ReviewThreadObservation,
  ): Promise<{ origin: string | undefined; symbol: string | undefined }> {
    if (thread.originalCommit === undefined || thread.originalLine === null) {
      return { origin: undefined, symbol: undefined };
    }
    const [origin, source] = await Promise.all([
      this.blame
        .blameOrigin(thread.originalCommit, thread.path, thread.originalLine)
        .catch(() => undefined),
      this.blame.fileAt(thread.originalCommit, thread.path).catch(() => undefined),
    ]);
    return {
      origin,
      symbol: source === undefined ? undefined : enclosingSymbol(source, thread.originalLine),
    };
  }
}
