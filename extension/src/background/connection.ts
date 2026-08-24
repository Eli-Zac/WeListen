import {
  ServerMessageSchema,
  PROTOCOL_VERSION,
  type ClientMessage,
  type Command,
  type PartyState,
  type PartyStatePatch,
  type PlayerState,
  type StalledReason,
} from '@welisten/protocol';
import { ClockEstimator, type ClockEstimate } from './clock.js';
import { WS_URL, CLIENT_VERSION } from '../shared/constants.js';
import { makeLogger } from '../shared/logger.js';

const log = makeLogger('connection');

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface ConnectionEvents {
  onStatus: (status: ConnectionStatus) => void;
  /** Full snapshot, from `welcome` on (re)connect. */
  onWelcome: (state: PartyState, epoch: number) => void;
  /** Incremental, already epoch-filtered (docs/PROTOCOL.md §4: discard non-increasing epochs). */
  onStatePatch: (patch: PartyStatePatch, epoch: number) => void;
  onClock: (clock: ClockEstimate) => void;
  onNotice: (notice: { level: string; code: string; message: string }) => void;
}

// docs/SYNC.md §1: 5 rapid pings to seed the estimate, then every 20s — which
// doubles as the MV3 service-worker-keepalive heartbeat (docs/ARCHITECTURE.md §3).
const PING_SEED_COUNT = 5;
const PING_INTERVAL_MS = 20_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;

export class Connection {
  private ws: WebSocket | null = null;
  private clockEstimator = new ClockEstimator();
  private reconnectAttempt = 0;
  private closedByUs = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private latestEpoch = 0;

  constructor(
    private nick: string,
    private events: ConnectionEvents
  ) {}

  connect(): void {
    this.closedByUs = false;
    this.events.onStatus(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.addEventListener('open', () => this.onOpen());
    ws.addEventListener('message', (evt) => this.onMessage(evt));
    ws.addEventListener('close', () => this.onClose());
    ws.addEventListener('error', (evt) => log.warn('socket error', evt));
  }

  close(): void {
    this.closedByUs = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  sendCommand(c: Command): void {
    this.send({ t: 'cmd', id: crypto.randomUUID(), epoch: this.latestEpoch, c });
  }

  sendProgress(positionMs: number, playerState: PlayerState, stalled?: StalledReason): void {
    this.send({ t: 'progress', positionMs, playerState, ...(stalled ? { stalled } : {}) });
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onOpen(): void {
    this.reconnectAttempt = 0;
    this.send({ t: 'hello', protocol: PROTOCOL_VERSION, nick: this.nick, clientVersion: CLIENT_VERSION });
    for (let i = 0; i < PING_SEED_COUNT; i++) {
      setTimeout(() => this.sendPing(), i * 50);
    }
    this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  private sendPing(): void {
    this.send({ t: 'ping', clientMs: Date.now() });
  }

  private onMessage(evt: MessageEvent): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(evt.data as string);
    } catch {
      return;
    }
    const result = ServerMessageSchema.safeParse(parsed);
    if (!result.success) {
      log.warn('dropped malformed server message', result.error.message);
      return;
    }
    const msg = result.data;

    switch (msg.t) {
      case 'welcome':
        this.latestEpoch = msg.epoch;
        this.events.onStatus('connected');
        this.events.onWelcome(msg.state, msg.epoch);
        break;
      case 'pong': {
        const receivedAtMs = Date.now();
        this.clockEstimator.recordSample(msg.clientMs, msg.serverMs, receivedAtMs);
        this.events.onClock(this.clockEstimator.estimate(receivedAtMs));
        break;
      }
      case 'state':
        if (msg.epoch <= this.latestEpoch) return; // docs/PROTOCOL.md §4
        this.latestEpoch = msg.epoch;
        this.events.onStatePatch(msg.patch, msg.epoch);
        break;
      case 'notice':
        this.events.onNotice(msg);
        break;
    }
  }

  private onClose(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws = null;
    if (this.closedByUs) {
      this.events.onStatus('disconnected');
      return;
    }
    this.events.onStatus('reconnecting');
    const delay =
      Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt) * (0.75 + Math.random() * 0.5);
    this.reconnectAttempt++;
    setTimeout(() => this.connect(), delay);
  }
}
