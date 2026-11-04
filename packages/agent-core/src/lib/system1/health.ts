/**
 * Process-wide System 1 health: one daemon serves every run, so breaker and
 * in-flight limit are shared. A down daemon costs a few failures, then the
 * breaker answers "skip" in ~0 ms until a half-open probe succeeds.
 */
export type System1HealthOptions = {
  /** Consecutive transport failures (unreachable, timeout, 5xx) that open the breaker. */
  failureThreshold: number;
  /** Consecutive bad responses that open the breaker. */
  badResponseThreshold: number;
  cooldownMs: number;
  maxInFlight: number;
};

export const DEFAULT_SYSTEM1_HEALTH: System1HealthOptions = {
  failureThreshold: 3,
  badResponseThreshold: 5,
  cooldownMs: 30_000,
  maxInFlight: 2,
};

type BreakerState = 'closed' | 'open' | 'half_open';

export class System1Health {
  private state: BreakerState = 'closed';
  private openedAt = 0;
  private failures = 0;
  private badResponses = 0;
  private probing = false;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly options: System1HealthOptions = DEFAULT_SYSTEM1_HEALTH,
    private readonly now: () => number = Date.now,
  ) {}

  /** False while the breaker is open (or a half-open probe is already out). */
  admit(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (this.now() - this.openedAt < this.options.cooldownMs) return false;
      this.state = 'half_open';
    }
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  /**
   * A slot for one request, or null when none frees up within `waitMs`.
   * The returned function releases the slot; call it exactly once.
   */
  async acquire(waitMs: number): Promise<(() => void) | null> {
    if (this.inFlight < this.options.maxInFlight) {
      this.inFlight++;
      return this.releaser();
    }
    return new Promise((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        this.inFlight++;
        resolve(this.releaser());
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(null);
      }, waitMs);
      this.waiters.push(grant);
    });
  }

  success(): void {
    this.failures = 0;
    this.badResponses = 0;
    this.state = 'closed';
    this.probing = false;
  }

  /** Transport failure: unreachable, timeout, 5xx. */
  failure(): void {
    this.failures++;
    this.trip(this.failures >= this.options.failureThreshold);
  }

  /** The daemon answered, but not in the expected shape. */
  badResponse(): void {
    this.badResponses++;
    this.trip(this.badResponses >= this.options.badResponseThreshold);
  }

  /** A probe or call that ended without a verdict (e.g. run cancelled). */
  release(): void {
    this.probing = false;
  }

  get breakerState(): BreakerState {
    return this.state;
  }

  private trip(thresholdReached: boolean): void {
    // A failed half-open probe re-opens immediately.
    if (thresholdReached || this.state === 'half_open') {
      this.state = 'open';
      this.openedAt = this.now();
    }
    this.probing = false;
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight--;
      const next = this.waiters.shift();
      next?.();
    };
  }
}
