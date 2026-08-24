import type { PartyState, Command } from './schema.js';
import { currentPositionMs } from './anchor.js';

/**
 * The single pure reducer, shared between the Durable Object and the
 * extension's optimistic-apply layer — see docs/PROTOCOL.md §5-6 and
 * docs/ARCHITECTURE.md §6. Must stay a pure function of (state, command,
 * context): no I/O, no randomness, no reliance on wall-clock `Date.now()`
 * (the caller supplies `nowServerMs`), so the client can predict the
 * server's result and a test can replay a command corpus deterministically.
 */
export interface ReduceContext {
  nowServerMs: number;
  memberId: string;
}

export function reduce(state: PartyState, command: Command, ctx: ReduceContext): PartyState {
  switch (command.k) {
    case 'play': {
      if (!state.nowPlaying || state.nowPlaying.rate !== 0) return state;
      const positionMs = currentPositionMs(state.nowPlaying, ctx.nowServerMs);
      return {
        ...state,
        epoch: state.epoch + 1,
        nowPlaying: { ...state.nowPlaying, positionMs, atServerMs: ctx.nowServerMs, rate: 1 },
      };
    }
    case 'pause': {
      if (!state.nowPlaying || state.nowPlaying.rate === 0) return state;
      const positionMs = currentPositionMs(state.nowPlaying, ctx.nowServerMs);
      return {
        ...state,
        epoch: state.epoch + 1,
        nowPlaying: { ...state.nowPlaying, positionMs, atServerMs: ctx.nowServerMs, rate: 0 },
      };
    }
    case 'seek': {
      if (!state.nowPlaying) return state;
      return {
        ...state,
        epoch: state.epoch + 1,
        nowPlaying: {
          ...state.nowPlaying,
          positionMs: command.positionMs,
          atServerMs: ctx.nowServerMs,
        },
      };
    }
    case 'rename': {
      const members = state.members.map((m) =>
        m.memberId === ctx.memberId ? { ...m, nick: command.nick } : m
      );
      return { ...state, epoch: state.epoch + 1, members };
    }
    case 'setOption': {
      return {
        ...state,
        epoch: state.epoch + 1,
        options: { ...state.options, [command.option]: command.value },
      };
    }
    // Queue mutation and multi-track transport are Phase 2/3 work — fractional
    // index ordering (D6, ROADMAP.md Phase 3) and server-driven advance don't
    // exist yet. Phase 1 hardcodes a single track and no queue, so these are
    // accepted (they must not error a client that sends one) but do nothing.
    case 'next':
    case 'prev':
    case 'jumpTo':
    case 'add':
    case 'remove':
    case 'move':
    case 'clear':
      return state;
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}
