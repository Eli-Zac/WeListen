import type { PartyState, PartyStatePatch } from '@welisten/protocol';
import { Connection, type ConnectionStatus } from './connection.js';
import type { ClockEstimate } from './clock.js';
import { TabRegistry } from './tabs.js';
import { type BackgroundToContent, type ContentToBackground } from '../shared/port-protocol.js';
import { makeLogger } from '../shared/logger.js';

const log = makeLogger('session');

export type SessionPhase = 'idle' | 'joining' | 'live' | 'reconnecting';

function randomNick(): string {
  return `Guest-${Math.random().toString(36).slice(2, 6)}`;
}

// docs/ARCHITECTURE.md §7 session.ts: "party state machine: idle -> joining
// -> live -> reconnecting". Owns the one Connection for this browser and fans
// its events out to every connected tab's Port.
export class Session {
  phase: SessionPhase = 'idle';
  private tabs = new TabRegistry();
  private connection: Connection;
  private latestState: PartyState | null = null;
  private latestClock: ClockEstimate | null = null;
  private latestStatus: ConnectionStatus = 'connecting';

  constructor(nick: string = randomNick()) {
    this.connection = new Connection(nick, {
      onStatus: (status) => this.onStatus(status),
      onWelcome: (state, epoch) => this.onWelcome(state, epoch),
      onStatePatch: (patch, epoch) => this.onStatePatch(patch, epoch),
      onClock: (clock) => this.onClock(clock),
      onNotice: (notice) => this.broadcast({ t: 'notice', ...notice }),
    });
  }

  start(): void {
    log.info('starting session');
    this.phase = 'joining';
    this.connection.connect();
  }

  attachTab(tabId: number, port: chrome.runtime.Port): void {
    const { becameActive } = this.tabs.add(tabId, port);
    port.postMessage({ t: 'active', active: becameActive } satisfies BackgroundToContent);
    port.postMessage({ t: 'status', status: this.latestStatus } satisfies BackgroundToContent);
    if (this.latestState) {
      port.postMessage({
        t: 'welcome',
        state: this.latestState,
        epoch: this.latestState.epoch,
      } satisfies BackgroundToContent);
    }
    if (this.latestClock) {
      port.postMessage({ t: 'clock', clock: this.latestClock } satisfies BackgroundToContent);
    }

    port.onMessage.addListener((msg: ContentToBackground) => this.onPortMessage(tabId, msg));
    port.onDisconnect.addListener(() => {
      const { activeChanged } = this.tabs.remove(tabId);
      if (activeChanged) {
        this.tabs.activePort()?.postMessage({ t: 'active', active: true } satisfies BackgroundToContent);
      }
    });
  }

  private onStatus(status: ConnectionStatus): void {
    this.latestStatus = status;
    this.phase = status === 'connected' ? 'live' : status === 'reconnecting' ? 'reconnecting' : this.phase;
    this.broadcast({ t: 'status', status });
  }

  private onWelcome(state: PartyState, epoch: number): void {
    this.latestState = state;
    this.broadcast({ t: 'welcome', state, epoch });
  }

  private onStatePatch(patch: PartyStatePatch, epoch: number): void {
    // zod types every field of a .partial() as `T | undefined` even though a
    // key parsed from real JSON is either present-with-a-value or absent,
    // never present-with-literal-undefined — safe to merge as a full state.
    if (this.latestState) this.latestState = { ...this.latestState, ...patch } as PartyState;
    this.broadcast({ t: 'patch', patch, epoch });
  }

  private onClock(clock: ClockEstimate): void {
    this.latestClock = clock;
    this.broadcast({ t: 'clock', clock });
  }

  private broadcast(msg: BackgroundToContent): void {
    for (const port of this.tabs.allPorts()) {
      try {
        port.postMessage(msg);
      } catch {
        // port is gone; its onDisconnect listener will clean up membership
      }
    }
  }

  private onPortMessage(tabId: number, msg: ContentToBackground): void {
    if (!this.tabs.isActive(tabId)) return; // only the active tab drives the player
    switch (msg.t) {
      case 'progress':
        this.connection.sendProgress(msg.positionMs, msg.playerState, msg.stalled);
        return;
      case 'cmd':
        this.connection.sendCommand(msg.c);
        return;
    }
  }
}
