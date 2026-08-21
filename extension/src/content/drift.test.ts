import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Anchor } from '@welisten/protocol';
import { decideCorrection, DampingState, targetPositionMs } from './drift.js';
import type { ClockEstimate } from '../background/clock.js';

// targetPositionMs() reads Date.now() internally, so every test pins the
// system clock to a known instant and anchors nowServerMs there — isolating
// "drift" to exactly the numbers each test sets up, not real wall-clock time.
const NOW = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function clock(offsetMs: number): ClockEstimate {
  return { offsetMs, rttMs: 20, confidence: 'good', updatedAt: NOW };
}

function anchorAt(positionMs: number, rate = 1): Anchor {
  return { itemId: 'i1', videoId: 'v1', positionMs, atServerMs: NOW, rate };
}

describe('targetPositionMs', () => {
  it('holds still for a paused anchor regardless of clock offset', () => {
    expect(targetPositionMs(anchorAt(5000, 0), clock(999))).toBe(5000);
  });

  it('combines the anchor position and the clock offset for a playing anchor', () => {
    // nowServerMs = Date.now() + offset = NOW + 250; elapsed since atServerMs (NOW) is 250ms at rate 1.
    expect(targetPositionMs(anchorAt(1000), clock(250))).toBe(1250);
  });
});

describe('decideCorrection', () => {
  it('does nothing inside the 25ms deadband when rate-nudging is enabled', () => {
    const c = decideCorrection(1010, anchorAt(1000), clock(0), 'v1', true);
    expect(c.type).toBe('none');
  });

  it('rate-nudges for a moderate drift, slowing down when ahead of target', () => {
    const c = decideCorrection(1100, anchorAt(1000), clock(0), 'v1', true); // +100ms ahead
    expect(c.type).toBe('rateNudge');
    expect(c.rate).toBeLessThan(1);
  });

  it('rate-nudges for a moderate drift, speeding up when behind target', () => {
    const c = decideCorrection(900, anchorAt(1000), clock(0), 'v1', true); // -100ms behind
    expect(c.type).toBe('rateNudge');
    expect(c.rate).toBeGreaterThan(1);
  });

  it('escalates to aggressive rate-nudge between 250ms and 2s of drift', () => {
    const c = decideCorrection(1500, anchorAt(1000), clock(0), 'v1', true); // +500ms
    expect(c.type).toBe('aggressiveRateNudge');
  });

  it('hard-seeks beyond 2s of drift, targeting the true current position', () => {
    const c = decideCorrection(5000, anchorAt(1000), clock(0), 'v1', true); // +4000ms
    expect(c.type).toBe('hardSeek');
    expect(c.seekToMs).toBe(1000); // targetPositionMs(anchor, clock) exactly
  });

  it('treats a different videoId as wrongTrack regardless of position', () => {
    const c = decideCorrection(1000, anchorAt(1000), clock(0), 'some-other-video', true);
    expect(c.type).toBe('wrongTrack');
  });

  it('falls back to a wide seek-only deadband when rate-nudging is disabled', () => {
    const small = decideCorrection(1300, anchorAt(1000), clock(0), 'v1', false); // 300ms: inside 400ms fallback deadband
    expect(small.type).toBe('none');

    const large = decideCorrection(1500, anchorAt(1000), clock(0), 'v1', false); // 500ms: beyond it
    expect(large.type).toBe('hardSeek');
  });
});

describe('DampingState', () => {
  it('blocks corrections until the refractory period passes after a hard seek', () => {
    const d = new DampingState();
    expect(d.canCorrect(0)).toBe(true);
    d.beginCorrection('hardSeek', 0);
    d.endCorrection();
    expect(d.canCorrect(100)).toBe(false); // still refractory (1.5s)
    expect(d.canCorrect(1600)).toBe(true);
  });

  it('does not impose a refractory period after a plain rate nudge', () => {
    const d = new DampingState();
    d.beginCorrection('rateNudge', 0);
    d.endCorrection();
    expect(d.canCorrect(1)).toBe(true);
  });

  it('marks the client degraded after more than 6 corrections in a 60s window', () => {
    const d = new DampingState();
    for (let i = 0; i < 6; i++) {
      d.beginCorrection('rateNudge', i * 1000);
      d.endCorrection();
    }
    expect(d.degraded).toBe(false);
    d.beginCorrection('rateNudge', 6000);
    d.endCorrection();
    expect(d.degraded).toBe(true);
  });

  it('does not count a correction older than 60s toward the degraded threshold', () => {
    const d = new DampingState();
    d.beginCorrection('rateNudge', 0);
    d.endCorrection();
    for (let i = 0; i < 6; i++) {
      d.beginCorrection('rateNudge', 61_000 + i * 1000);
      d.endCorrection();
    }
    expect(d.degraded).toBe(false);
  });

  it('only allows one correction in flight at a time', () => {
    const d = new DampingState();
    d.beginCorrection('rateNudge', 0);
    expect(d.canCorrect(0)).toBe(false);
    d.endCorrection();
    expect(d.canCorrect(0)).toBe(true);
  });
});
