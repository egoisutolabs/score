export interface DaemonPhase {
  readonly name: string;
  /** Phase runs on ticks where `tick % everyTicks === 0`; tick 0 runs every phase. */
  readonly everyTicks: number;
  run(): Promise<void>;
}

export function duePhases(phases: readonly DaemonPhase[], tick: number): readonly DaemonPhase[] {
  return phases.filter((phase) => tick % phase.everyTicks === 0);
}

/**
 * One tick counter for the whole daemon: phases declare tick multiples instead
 * of their own intervals, so there is no clock to inject and no drift to
 * compensate. Phases run strictly in the order given; one that throws is
 * reported and the rest of the pass continues.
 */
export class DaemonService {
  #tick = 0;

  constructor(
    private readonly phases: readonly DaemonPhase[],
    private readonly onPhaseError: (name: string, error: unknown) => void,
  ) {}

  get tick(): number {
    return this.#tick;
  }

  async runPass(): Promise<void> {
    for (const phase of duePhases(this.phases, this.#tick)) {
      try {
        await phase.run();
      } catch (error) {
        this.onPhaseError(phase.name, error);
      }
    }
    this.#tick += 1;
  }
}
