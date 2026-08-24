import { describe, expect, it } from 'vitest';
import { ClockEstimator } from './clock.js';

describe('ClockEstimator', () => {
  it('reports seeding confidence before enough samples arrive', () => {
    const est = new ClockEstimator();
    est.recordSample(1000, 1050, 1010);
    const estimate = est.estimate(1010);
    expect(estimate.confidence).toBe('seeding');
  });

  it('computes offset as serverMs - midpoint(clientMs, receivedAtMs)', () => {
    const est = new ClockEstimator();
    // t0=1000 (client send), t1=1050 (server receive+reply == serverMs), t2=1020 (client receive)
    est.recordSample(1000, 1050, 1020);
    const estimate = est.estimate(1020);
    // midpoint = (1000+1020)/2 = 1010; offset = 1050 - 1010 = 40
    expect(estimate.offsetMs).toBe(40);
    expect(estimate.rttMs).toBe(20);
  });

  it('picks the lowest-RTT sample as the best (least path asymmetry)', () => {
    const est = new ClockEstimator();
    est.recordSample(0, 100, 200); // rtt 200, offset = 100 - 100 = 0
    est.recordSample(1000, 1105, 1050); // rtt 50, offset = 1105 - 1025 = 80
    est.recordSample(2000, 2210, 2400); // rtt 400, offset = 2210 - 2200 = 10
    const estimate = est.estimate(2400);
    expect(estimate.rttMs).toBe(50);
    expect(estimate.offsetMs).toBe(80);
  });

  it('reaches good confidence with 5+ consistent samples (low stddev)', () => {
    const est = new ClockEstimator();
    for (let i = 0; i < 5; i++) {
      const t0 = i * 1000;
      est.recordSample(t0, t0 + 50 + i, t0 + 20); // near-constant ~50ms offset, tiny jitter
    }
    expect(est.isSettled()).toBe(true);
    expect(est.estimate(5000).confidence).toBe('good');
  });

  it('reports degraded confidence when offsets disagree wildly (hostile/asymmetric samples)', () => {
    const est = new ClockEstimator();
    const chaoticOffsets = [10, 500, -300, 200, 5];
    for (let i = 0; i < chaoticOffsets.length; i++) {
      const t0 = i * 1000;
      const serverMs = t0 + chaoticOffsets[i]!;
      est.recordSample(t0, serverMs, t0 + 20);
    }
    expect(est.isSettled()).toBe(false);
    expect(est.estimate(5000).confidence).toBe('degraded');
  });

  it('keeps only the most recent 8 samples (rolling window)', () => {
    const est = new ClockEstimator();
    // First a very-low-RTT, high-offset sample that should eventually age out...
    est.recordSample(0, 1000, 10); // rtt 10, offset huge
    // ...then 8 more more-recent, low-offset, higher-RTT samples that push it out of the window.
    for (let i = 1; i <= 8; i++) {
      const t0 = i * 1000;
      est.recordSample(t0, t0 + 5, t0 + 40); // rtt 40, offset ~5
    }
    const estimate = est.estimate(9000);
    // With the window full of rtt-40 samples, the best (lowest RTT) is one of those, not the aged-out rtt-10 one.
    expect(estimate.rttMs).toBe(40);
  });
});
