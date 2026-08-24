import type { Anchor } from './schema.js';

/**
 * Derives "where should playback be right now" from an anchor and a server
 * timestamp. Pure — no clock estimate involved, that's layered on top by the
 * caller (see docs/SYNC.md §2, which adds the client's clock offset on top of
 * this same formula).
 */
export function currentPositionMs(anchor: Anchor, nowServerMs: number): number {
  return anchor.positionMs + (nowServerMs - anchor.atServerMs) * anchor.rate;
}
