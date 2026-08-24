import { describe, expect, it } from 'vitest';
import { currentPositionMs } from './anchor.js';
import type { Anchor } from './schema.js';

describe('currentPositionMs', () => {
  it('holds still while paused (rate 0)', () => {
    const anchor: Anchor = { itemId: 'i1', videoId: 'v1', positionMs: 5000, atServerMs: 1000, rate: 0 };
    expect(currentPositionMs(anchor, 1000)).toBe(5000);
    expect(currentPositionMs(anchor, 50000)).toBe(5000);
  });

  it('advances linearly at rate 1', () => {
    const anchor: Anchor = { itemId: 'i1', videoId: 'v1', positionMs: 5000, atServerMs: 1000, rate: 1 };
    expect(currentPositionMs(anchor, 1000)).toBe(5000);
    expect(currentPositionMs(anchor, 3000)).toBe(7000);
  });

  it('scales by rate during a rate-nudge correction', () => {
    const anchor: Anchor = { itemId: 'i1', videoId: 'v1', positionMs: 0, atServerMs: 0, rate: 1.02 };
    expect(currentPositionMs(anchor, 1000)).toBeCloseTo(1020, 5);
  });

  it('is a pure function of its inputs (no drift from repeated calls)', () => {
    const anchor: Anchor = { itemId: 'i1', videoId: 'v1', positionMs: 1000, atServerMs: 500, rate: 1 };
    const a = currentPositionMs(anchor, 2000);
    const b = currentPositionMs(anchor, 2000);
    expect(a).toBe(b);
  });
});
