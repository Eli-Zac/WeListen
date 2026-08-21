import type { Command, PartyState, PartyStatePatch, PlayerState, StalledReason } from '@welisten/protocol';
import type { ClockEstimate } from '../background/clock.js';
import type { ConnectionStatus } from '../background/connection.js';

// background <-> content, over a chrome.runtime.Port. Unlike the MAIN <->
// ISOLATED bridge, both ends here are our own code shipped in the same
// extension, so there's no nonce/hostile-input concern — this is a plain,
// trusted internal channel.

export const PORT_NAME = 'welisten-tab';

export type BackgroundToContent =
  | { t: 'status'; status: ConnectionStatus }
  | { t: 'welcome'; state: PartyState; epoch: number }
  | { t: 'patch'; patch: PartyStatePatch; epoch: number }
  | { t: 'clock'; clock: ClockEstimate }
  | { t: 'notice'; level: string; code: string; message: string }
  | { t: 'active'; active: boolean };

export type ContentToBackground =
  | { t: 'progress'; positionMs: number; playerState: PlayerState; stalled?: StalledReason }
  | { t: 'cmd'; c: Command };
