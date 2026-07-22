import type { BuildGate, LandingResult, PullRequestObservation } from "@/features/landing/change";
import { evaluatePreconditions, gatesFor, listLandingCandidates } from "@/features/landing/policy";
import type { ChangeHost } from "@/features/landing/port";
import type { CommandRunner } from "@/shared/command-runner";
import type { WorkspaceDriver } from "@/shared/workspace-driver";

export interface LandingServiceOptions {
  readonly repositoryRoot: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly dryRun: boolean;
  readonly noMerge: boolean;
  readonly maxMerges: number;
  /** Consecutive green ticks required before merging (legacy soaked on wall clock). */
  readonly soakTicks: number;
  readonly skipLabels: readonly string[];
  readonly onlyIssueBranches: boolean;
}

/** Full port of babysitPr/tick: local integration, merged-tree gates, soak, commit, push. */
export class LandingService {
  readonly #readyTicks = new Map<number, number>();

  constructor(
    private readonly options: LandingServiceOptions,
    private readonly changes: ChangeHost,
    private readonly workspace: WorkspaceDriver,
    private readonly runner: CommandRunner,
  ) {}

  async runTick(): Promise<readonly LandingResult[]> {
    await this.workspace.fetchOrigin();
    const canMerge = this.options.dryRun || (await this.#mainCheckoutReady());
    const changes = listLandingCandidates(await this.changes.observeOpenChanges(), this.options);
    const live = new Set(changes.map((change) => change.number));
    for (const number of this.#readyTicks.keys()) {
      if (!live.has(number)) this.#readyTicks.delete(number);
    }

    const results: LandingResult[] = [];
    let merges = 0;
    for (const change of changes) {
      if (
        !canMerge ||
        (!this.options.dryRun && !this.options.noMerge && merges >= this.options.maxMerges)
      ) {
        results.push({ pullRequestNumber: change.number, tag: "skipped", note: "not processed" });
        continue;
      }

      let result: LandingResult;
      try {
        result = await this.#land(change);
      } catch (error) {
        await this.workspace.abortMerge().catch(() => undefined);
        result = {
          pullRequestNumber: change.number,
          tag: "build-red",
          note: `unexpected: ${errorMessage(error)}`,
        };
      }
      if (!result.keepTimer) this.#readyTicks.delete(change.number);
      if (result.tag === "merged") merges += 1;
      results.push(result);
    }
    return results;
  }

  async #land(change: PullRequestObservation): Promise<LandingResult> {
    const gates = gatesFor(change, this.options.repositoryRoot);
    const gateNames = gates.map((gate) => gate.name).join("+") || "none (skills/docs)";
    // Legacy performs cheap checks before the GraphQL review-thread query.
    let blocker = evaluatePreconditions(change, 0);
    if (blocker) return blocker;
    blocker = evaluatePreconditions(
      change,
      await this.changes.unresolvedThreadCount(change.number),
    );
    if (blocker) return blocker;

    if (this.options.dryRun) {
      return {
        pullRequestNumber: change.number,
        tag: "would-merge",
        note: `clean+resolved; would soak ${this.options.soakTicks} green ticks then merge (gates: ${gateNames})`,
      };
    }

    await this.workspace.fetchOrigin();
    if (!(await this.workspace.stageMerge(change.headRefName))) {
      await this.workspace.abortMerge().catch(() => undefined);
      return {
        pullRequestNumber: change.number,
        tag: "conflict",
        note: "git merge hit conflicts (aborted)",
      };
    }

    const gateFailure = await this.#runGates(gates);
    if (gateFailure) {
      await this.workspace.abortMerge().catch(() => undefined);
      return { pullRequestNumber: change.number, tag: "build-red", note: gateFailure };
    }

    const greenTicks = (this.#readyTicks.get(change.number) ?? 0) + 1;
    this.#readyTicks.set(change.number, greenTicks);
    const remaining = this.options.soakTicks - greenTicks;
    if (remaining > 0) {
      await this.workspace.abortMerge().catch(() => undefined);
      return {
        pullRequestNumber: change.number,
        tag: "soaking",
        note: `green+resolved (${gateNames}); merging ${remaining === 1 ? "next tick" : `in ${remaining} ticks`} if still green`,
        keepTimer: true,
      };
    }

    if (this.options.noMerge) {
      await this.workspace.abortMerge().catch(() => undefined);
      return {
        pullRequestNumber: change.number,
        tag: "ready",
        note: `soak complete (${gateNames}); --no-merge, not pushed`,
        keepTimer: true,
      };
    }

    const owner = this.options.repository.split("/")[0];
    const message = `Merge pull request #${change.number} from ${owner}/${change.headRefName}\n\n${change.title}`;
    await this.workspace.commitMerge(message);
    await this.workspace.pushDefaultBranch(this.options.defaultBranch);
    return {
      pullRequestNumber: change.number,
      tag: "merged",
      note: `soak complete (${gateNames})`,
    };
  }

  async #mainCheckoutReady(): Promise<boolean> {
    const checkout = await this.workspace.observePrimaryCheckout();
    if (checkout.branch !== this.options.defaultBranch) return false;
    const meaningfulStatus = checkout.status
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.includes(".claude/scheduled_tasks.lock"));
    return meaningfulStatus.length === 0;
  }

  async #runGates(gates: readonly BuildGate[]): Promise<string | null> {
    for (const gate of gates) {
      for (const step of gate.steps) {
        let result = await this.#tryGateStep(step.command, gate.cwd);
        if (!result.ok && step.retry) result = await this.#tryGateStep(step.command, gate.cwd);
        if (!result.ok) {
          const tail = result.output.split(/\r?\n/).filter(Boolean).slice(-4).join(" | ");
          return `${gate.name}:${step.label} — ${tail}`;
        }
      }
    }
    return null;
  }

  async #tryGateStep(
    command: readonly string[],
    cwd: string,
  ): Promise<{ readonly ok: boolean; readonly output: string }> {
    try {
      const result = await this.runner.run(command, { cwd });
      return {
        ok: result.exitCode === 0 && !result.timedOut,
        output: result.stderr || result.stdout,
      };
    } catch (error) {
      return { ok: false, output: errorMessage(error) };
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
