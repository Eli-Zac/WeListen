// Injected latency, jitter, and packet loss — docs/SYNC.md §8. Delivery is
// scheduled via setTimeout so it composes with vitest's fake timers: the
// whole simulation runs on virtual time, fast, deterministic given a seeded
// RNG (see `rng` below).
export interface NetworkConfig {
  baseLatencyMs: number;
  jitterMs: number;
  lossRate: number; // 0..1, applied per message
}

// A tiny seeded PRNG (mulberry32) so a failing simulation run is reproducible
// from its seed rather than a fresh random failure every time.
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SimulatedNetwork {
  constructor(
    private config: NetworkConfig,
    private rng: () => number
  ) {}

  /** Delivers `payload` to `onDeliver` after simulated latency, or drops it per lossRate. */
  send<T>(payload: T, onDeliver: (p: T) => void): void {
    if (this.rng() < this.config.lossRate) return; // dropped
    const delay = Math.max(0, this.config.baseLatencyMs + (this.rng() * 2 - 1) * this.config.jitterMs);
    setTimeout(() => onDeliver(payload), delay);
  }
}
