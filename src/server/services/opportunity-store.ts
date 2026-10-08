import type { OpportunityRun } from "../../shared/opportunities.js";

export class OpportunityStore {
  private readonly runs = new Map<string, OpportunityRun>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly now: () => number = Date.now,
    cleanupIntervalMs = 60_000
  ) {
    this.timer = setInterval(() => this.prune(), cleanupIntervalMs);
    this.timer.unref();
  }

  put(run: OpportunityRun): OpportunityRun {
    this.prune();
    this.runs.set(run.id, run);
    return run;
  }

  get(id: string): OpportunityRun {
    this.prune();
    const run = this.runs.get(id);
    if (!run) throw new Error(`Opportunity run expired or not found: ${id}`);
    return run;
  }

  delete(id: string): boolean {
    return this.runs.delete(id);
  }

  prune(): number {
    const now = this.now();
    let removed = 0;
    for (const [id, run] of this.runs) {
      if (new Date(run.expiresAt).getTime() <= now) {
        this.runs.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

export const opportunityStore = new OpportunityStore();
