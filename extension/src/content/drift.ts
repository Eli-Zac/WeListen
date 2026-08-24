import type { Anchor } from '@welisten/protocol';
import { currentPositionMs } from '@welisten/protocol';
import type { ClockEstimate } from '../background/clock.js';

// The drift controller — docs/SYNC.md §2-3. Runs at 4Hz on the active tab.
// This module is pure decision logic (given the current numbers, what
// correction, if any); content/index.ts owns the timer and the bridge calls.

/** docs/SYNC.md §2: where should playback be right now, given the anchor and this client's clock estimate. */
export function targetPositionMs(anchor: Anchor, clock: ClockEstimate): number {
  const nowServerMs = Date.now() + clock.offsetMs;
  return currentPositionMs(anchor, nowServerMs);
}

export type CorrectionType = 'none' | 'rateNudge' | 'aggressiveRateNudge' | 'hardSeek' | 'wrongTrack';

export interface Correction {
  type: CorrectionType;
  driftMs: number;
  rate?: number;
  seekToMs?: number;
}

const DEADBAND_MS = 25;
const RATE_NUDGE_MAX_MS = 250;
const AGGRESSIVE_MAX_MS = 2000;
const RATE_NUDGE = 0.02;
const AGGRESSIVE_RATE_NUDGE = 0.05;

/**
 * Banded correction per docs/SYNC.md §3's table. `useRateNudge` is decided at
 * runtime from the Phase 0 probe result (Q2) — false falls back to a
 * seek-only controller with a much wider deadband, per SYNC.md's fallback
 * note. Phase 0 could not verify Q2 live (docs/probe-findings.md), so this
 * defaults to false until a real probe result says otherwise.
 */
export function decideCorrection(
  playerPositionMs: number,
  anchor: Anchor,
  clock: ClockEstimate,
  currentVideoId: string | null,
  useRateNudge: boolean
): Correction {
  if (currentVideoId !== null && currentVideoId !== anchor.videoId) {
    return { type: 'wrongTrack', driftMs: NaN, seekToMs: targetPositionMs(anchor, clock) };
  }

  const target = targetPositionMs(anchor, clock);
  const driftMs = playerPositionMs - target;
  const magnitude = Math.abs(driftMs);

  if (!useRateNudge) {
    // Seek-only fallback: much wider deadband so a jittery estimate doesn't
    // click constantly (docs/SYNC.md §3).
    if (magnitude < 400) return { type: 'none', driftMs };
    return { type: 'hardSeek', driftMs, seekToMs: target };
  }

  if (magnitude < DEADBAND_MS) return { type: 'none', driftMs };

  if (magnitude < RATE_NUDGE_MAX_MS) {
    const rate = 1 - Math.sign(driftMs) * RATE_NUDGE;
    return { type: 'rateNudge', driftMs, rate };
  }

  if (magnitude < AGGRESSIVE_MAX_MS) {
    const rate = 1 - Math.sign(driftMs) * AGGRESSIVE_RATE_NUDGE;
    return { type: 'aggressiveRateNudge', driftMs, rate };
  }

  return { type: 'hardSeek', driftMs, seekToMs: target };
}

/** docs/SYNC.md §3 "Damping". Tracks in-flight state across successive 4Hz ticks. */
export class DampingState {
  private correctionInFlight = false;
  private refractoryUntilMs = 0;
  private correctionTimestamps: number[] = [];
  degraded = false;

  canCorrect(nowMs: number): boolean {
    return !this.correctionInFlight && nowMs >= this.refractoryUntilMs;
  }

  beginCorrection(type: CorrectionType, nowMs: number): void {
    this.correctionInFlight = true;
    this.correctionTimestamps.push(nowMs);
    this.correctionTimestamps = this.correctionTimestamps.filter((t) => nowMs - t < 60_000);
    if (this.correctionTimestamps.length > 6) this.degraded = true;
    if (type === 'hardSeek' || type === 'wrongTrack') {
      this.refractoryUntilMs = nowMs + 1500; // player's reported position isn't trustworthy right after a seek
    }
  }

  endCorrection(): void {
    this.correctionInFlight = false;
  }
}
