// Offset/RTT estimation — docs/SYNC.md §1. A cut-down NTP exchange over the
// existing WebSocket (ping/pong), never performance.now() (wrong zero point
// per document, drifts under throttling — Date.now() is what's comparable
// across the client/server boundary).

export interface ClockSample {
  rttMs: number;
  offsetMs: number; // add to local Date.now() to get server time
  takenAt: number; // local Date.now() the sample was taken
}

export interface ClockEstimate {
  offsetMs: number;
  rttMs: number;
  confidence: 'seeding' | 'good' | 'degraded';
  updatedAt: number;
}

const WINDOW_SIZE = 8;
const SEED_SAMPLE_COUNT = 5;
const SEED_STDDEV_GATE_MS = 25;

export class ClockEstimator {
  private samples: ClockSample[] = [];
  private seeded = false;

  /** Call with the (clientMs, serverMs) pair from a `pong`, and the local receive time. */
  recordSample(clientMs: number, serverMs: number, receivedAtMs: number): ClockSample {
    const rttMs = receivedAtMs - clientMs;
    const offsetMs = serverMs - (clientMs + receivedAtMs) / 2;
    const sample: ClockSample = { rttMs, offsetMs, takenAt: receivedAtMs };
    this.samples.push(sample);
    if (this.samples.length > WINDOW_SIZE) this.samples.shift();
    if (this.samples.length >= SEED_SAMPLE_COUNT) this.seeded = true;
    return sample;
  }

  /** Best sample = lowest RTT: least queuing delay, therefore least path asymmetry error. */
  private bestSample(): ClockSample | null {
    if (this.samples.length === 0) return null;
    return this.samples.reduce((best, s) => (s.rttMs < best.rttMs ? s : best));
  }

  private seedStddevMs(): number | null {
    if (this.samples.length < SEED_SAMPLE_COUNT) return null;
    const offsets = this.samples.map((s) => s.offsetMs);
    const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;
    const variance = offsets.reduce((a, b) => a + (b - mean) ** 2, 0) / offsets.length;
    return Math.sqrt(variance);
  }

  estimate(nowMs: number): ClockEstimate {
    const best = this.bestSample();
    if (!best) {
      return { offsetMs: 0, rttMs: 0, confidence: 'seeding', updatedAt: nowMs };
    }

    let confidence: ClockEstimate['confidence'] = 'seeding';
    if (this.seeded) {
      const stddev = this.seedStddevMs();
      confidence = stddev !== null && stddev < SEED_STDDEV_GATE_MS ? 'good' : 'degraded';
    }

    return { offsetMs: best.offsetMs, rttMs: best.rttMs, confidence, updatedAt: nowMs };
  }

  /** docs/SYNC.md §1: gate joining playback on this, with a 3s hard timeout. */
  isSettled(): boolean {
    const stddev = this.seedStddevMs();
    return stddev !== null && stddev < SEED_STDDEV_GATE_MS;
  }
}
