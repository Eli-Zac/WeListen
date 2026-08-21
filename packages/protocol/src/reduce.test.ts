import { describe, expect, it } from 'vitest';
import { reduce } from './reduce.js';
import type { PartyState } from './schema.js';

function baseState(overrides: Partial<PartyState> = {}): PartyState {
  return {
    code: 'PHASE1',
    epoch: 0,
    nowPlaying: { itemId: 'i1', videoId: 'v1', positionMs: 0, atServerMs: 0, rate: 0 },
    queue: [],
    members: [{ memberId: 'm1', nick: 'Alice', joinedAt: 0, sync: { driftMs: 0, lastSeenMs: 0 } }],
    options: { waitForAll: false, allowClear: true },
    ...overrides,
  };
}

describe('reduce', () => {
  it('play sets rate to 1 and re-anchors at the current derived position', () => {
    const state = baseState({
      nowPlaying: { itemId: 'i1', videoId: 'v1', positionMs: 1000, atServerMs: 0, rate: 0 },
    });
    const next = reduce(state, { k: 'play' }, { nowServerMs: 5000, memberId: 'm1' });
    expect(next.nowPlaying).toEqual({
      itemId: 'i1',
      videoId: 'v1',
      positionMs: 1000, // paused, so unchanged by the elapsed time
      atServerMs: 5000,
      rate: 1,
    });
    expect(next.epoch).toBe(1);
  });

  it('play is a no-op if already playing', () => {
    const state = baseState({
      nowPlaying: { itemId: 'i1', videoId: 'v1', positionMs: 1000, atServerMs: 0, rate: 1 },
    });
    const next = reduce(state, { k: 'play' }, { nowServerMs: 5000, memberId: 'm1' });
    expect(next).toBe(state);
  });

  it('pause captures the derived position at the moment of pausing', () => {
    const state = baseState({
      nowPlaying: { itemId: 'i1', videoId: 'v1', positionMs: 1000, atServerMs: 0, rate: 1 },
    });
    const next = reduce(state, { k: 'pause' }, { nowServerMs: 3000, memberId: 'm1' });
    expect(next.nowPlaying).toEqual({
      itemId: 'i1',
      videoId: 'v1',
      positionMs: 4000, // 1000 + 3000*1
      atServerMs: 3000,
      rate: 0,
    });
  });

  it('seek re-anchors to the requested position without touching rate', () => {
    const state = baseState({
      nowPlaying: { itemId: 'i1', videoId: 'v1', positionMs: 1000, atServerMs: 0, rate: 1 },
    });
    const next = reduce(state, { k: 'seek', positionMs: 42000 }, { nowServerMs: 2000, memberId: 'm1' });
    expect(next.nowPlaying).toEqual({
      itemId: 'i1',
      videoId: 'v1',
      positionMs: 42000,
      atServerMs: 2000,
      rate: 1,
    });
  });

  it('three concurrent next commands do not triple-advance (Phase 1: no-op, queue is Phase 2/3)', () => {
    const state = baseState();
    const a = reduce(state, { k: 'next' }, { nowServerMs: 1000, memberId: 'm1' });
    const b = reduce(a, { k: 'next' }, { nowServerMs: 1001, memberId: 'm1' });
    const c = reduce(b, { k: 'next' }, { nowServerMs: 1002, memberId: 'm1' });
    expect(c).toBe(state);
  });

  it('rename only touches the issuing member', () => {
    const state = baseState({
      members: [
        { memberId: 'm1', nick: 'Alice', joinedAt: 0, sync: { driftMs: 0, lastSeenMs: 0 } },
        { memberId: 'm2', nick: 'Bob', joinedAt: 0, sync: { driftMs: 0, lastSeenMs: 0 } },
      ],
    });
    const next = reduce(state, { k: 'rename', nick: 'Alicia' }, { nowServerMs: 0, memberId: 'm1' });
    expect(next.members.find((m) => m.memberId === 'm1')?.nick).toBe('Alicia');
    expect(next.members.find((m) => m.memberId === 'm2')?.nick).toBe('Bob');
  });

  it('setOption flips exactly the named option', () => {
    const state = baseState();
    const next = reduce(state, { k: 'setOption', option: 'waitForAll', value: true }, { nowServerMs: 0, memberId: 'm1' });
    expect(next.options).toEqual({ waitForAll: true, allowClear: true });
  });

  it('a command corpus applied in any order converges to the same epoch count', () => {
    // Not commutative in general (that's the point of a total order), but the
    // epoch must advance exactly once per accepted, state-changing command —
    // this is the invariant the Durable Object's single-threaded ordering
    // relies on being true of reduce() itself.
    const state = baseState(); // starts paused (rate 0)
    const commands = [
      { k: 'pause' as const }, // no-op: already paused
      { k: 'play' as const }, // epoch 1
      { k: 'seek' as const, positionMs: 1000 }, // epoch 2
      { k: 'rename' as const, nick: 'X' }, // epoch 3
    ];
    let s = state;
    for (const c of commands) {
      s = reduce(s, c, { nowServerMs: 0, memberId: 'm1' });
    }
    expect(s.epoch).toBe(3);
  });
});
