import type { FindingClassifier } from "@score/core/repair/convergence/finding-classifier.interface";
import { NO_CLASSIFIER } from "@score/core/repair/convergence/finding-classifier.interface";
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
    private readonly ledger: FindingLedger,
    private readonly classifier: FindingClassifier = NO_CLASSIFIER,
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
    const lastWaveHead = this.ledger.lastWaveHead(pullRequestNumber);
    const records: FindingRecord[] = [];
    for (const thread of threads) {
      const prior = known.get(thread.id);
      if (prior) {
        records.push({ ...prior, resolution: resolutionOf(thread), resolvedBy: thread.resolvedBy });
        continue;
      }
      const { origin, symbol } = await this.#locate(thread);
      const key = findingKey(origin, thread, symbol);
      // Git failing to answer is "unknown", never "after": both readings below
      // feed the convergence rules, and an unproven regression must not park
      // the PR (the same benefit of the doubt classifyFinding gives blame).
      const beforeFirstHead =
        origin !== undefined && firstHead !== undefined
          ? await this.blame.ancestry(origin, firstHead)
          : undefined;
      const originAfterFirstHead = beforeFirstHead === undefined ? undefined : !beforeFirstHead;
      // The latest wave's head is what the agent was sent to fix; a line
      // blame places after it was written by that fix (convergence rule 3).
      // "After" needs both directions: not an ancestor of that head, and that
      // head an ancestor of it. A rebased or force-pushed branch fails the
      // first alone for every line, and divergence is unknown, not a fix.
      const fromLastFix =
        origin !== undefined && lastWaveHead !== undefined
          ? (await this.blame.ancestry(origin, lastWaveHead)) === false &&
            (await this.blame.ancestry(lastWaveHead, origin)) === true
          : false;
      // Prior includes this pass's earlier threads so two reviewers raising
      // one defect in the same round read as a duplicate, not two findings —
      // in their refreshed state, one record per thread: a same-key thread the
      // reviewer confirmed this pass must not still read as self-resolved.
      const priorRecords = [
        ...new Map([
          ...known,
          ...records.map((record) => [record.threadId, record] as const),
        ]).values(),
      ];
      const record: FindingRecord = {
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
        fromLastFix,
        resolution: resolutionOf(thread),
        resolvedBy: thread.resolvedBy,
      };
      // A classifier failure is no opinion, never a failed pass.
      const assessment = await this.classifier.assess(record).catch(() => undefined);
      records.push(assessment === undefined ? record : { ...record, real: assessment.real });
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
