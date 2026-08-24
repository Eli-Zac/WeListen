import {
  ClientMessageSchema,
  CloseCode,
  PROTOCOL_VERSION,
  currentPositionMs,
  reduce,
  type Hello,
  type Cmd,
  type Progress,
  type PartyState,
  type ServerMessage,
} from '@welisten/protocol';
import type { WorkerEnv as Env } from './env.js';

// Phase 1: one hardcoded party, one hardcoded track. Party creation
// (POST /v1/party), CSPRNG codes, and reconnect/resume are Phase 2 — see
// docs/ROADMAP.md. `hello.resume` is accepted for schema compatibility but
// ignored: every connection becomes a new member.
export const PHASE1_CODE = 'PHASE1';
export const PHASE1_VIDEO_ID = 'phase1-stub-track';

interface SessionMeta {
  helloReceived: true;
  memberId: string;
  nick: string;
}

function isSession(x: unknown): x is SessionMeta {
  return !!x && typeof x === 'object' && (x as { helloReceived?: unknown }).helloReceived === true;
}

function initialState(): PartyState {
  return {
    code: PHASE1_CODE,
    epoch: 0,
    nowPlaying: {
      itemId: 'phase1',
      videoId: PHASE1_VIDEO_ID,
      positionMs: 0,
      atServerMs: Date.now(),
      rate: 0,
    },
    queue: [],
    members: [],
    options: { waitForAll: false, allowClear: true },
  };
}

export class PartyRoom implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private cached: PartyState | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Hibernation API: the DO can be evicted from memory between messages
    // while this socket stays open — the reason an idle party costs nothing.
    // See docs/DECISIONS.md D1.
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async loadState(): Promise<PartyState> {
    if (this.cached) return this.cached;
    const stored = await this.state.storage.get<PartyState>('state');
    this.cached = stored ?? initialState();
    return this.cached;
  }

  private async saveState(next: PartyState): Promise<void> {
    this.cached = next;
    await this.state.storage.put('state', next);
  }

  private broadcast(msg: ServerMessage, exclude?: WebSocket): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      if (ws === exclude) continue;
      try {
        ws.send(payload);
      } catch {
        // socket is gone; webSocketClose will clean up membership
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      ws.close(CloseCode.PROTOCOL_VIOLATION, 'malformed json');
      return;
    }

    const result = ClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      ws.close(CloseCode.PROTOCOL_VIOLATION, 'schema validation failed');
      return;
    }
    const msg = result.data;

    const attachment = ws.deserializeAttachment();

    if (msg.t === 'hello') {
      if (isSession(attachment)) {
        ws.close(CloseCode.PROTOCOL_VIOLATION, 'duplicate hello');
        return;
      }
      await this.handleHello(ws, msg);
      return;
    }

    // hello must be the first frame on a connection (docs/PROTOCOL.md §2).
    if (!isSession(attachment)) {
      ws.close(CloseCode.PROTOCOL_VIOLATION, 'hello must be first');
      return;
    }

    switch (msg.t) {
      case 'ping':
        ws.send(
          JSON.stringify({ t: 'pong', clientMs: msg.clientMs, serverMs: Date.now() } satisfies ServerMessage)
        );
        return;
      case 'cmd':
        await this.handleCmd(ws, attachment, msg);
        return;
      case 'progress':
        await this.handleProgress(attachment, msg);
        return;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment();
    if (!isSession(attachment)) return;

    const state = await this.loadState();
    const members = state.members.filter((m) => m.memberId !== attachment.memberId);
    if (members.length === state.members.length) return;

    const next: PartyState = { ...state, epoch: state.epoch + 1, members };
    await this.saveState(next);
    this.broadcast({
      t: 'state',
      epoch: next.epoch,
      serverMs: Date.now(),
      patch: { members: next.members },
      by: { memberId: attachment.memberId, nick: attachment.nick },
      cause: 'memberLeft',
    });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  private async handleHello(ws: WebSocket, hello: Hello): Promise<void> {
    if (hello.protocol !== PROTOCOL_VERSION) {
      ws.close(CloseCode.VERSION_UNSUPPORTED, 'unsupported protocol version');
      return;
    }

    const state = await this.loadState();
    const memberId = crypto.randomUUID();
    const token = crypto.randomUUID();
    const now = Date.now();

    const next: PartyState = {
      ...state,
      epoch: state.epoch + 1,
      members: [
        ...state.members,
        { memberId, nick: hello.nick, joinedAt: now, sync: { driftMs: 0, lastSeenMs: now } },
      ],
    };
    await this.saveState(next);

    const session: SessionMeta = { helloReceived: true, memberId, nick: hello.nick };
    ws.serializeAttachment(session);

    ws.send(
      JSON.stringify({
        t: 'welcome',
        memberId,
        token,
        serverMs: now,
        epoch: next.epoch,
        state: next,
      } satisfies ServerMessage)
    );

    this.broadcast(
      {
        t: 'state',
        epoch: next.epoch,
        serverMs: now,
        patch: { members: next.members },
        by: { memberId, nick: hello.nick },
        cause: 'memberJoined',
      },
      ws
    );
  }

  private async handleCmd(ws: WebSocket, session: SessionMeta, cmd: Cmd): Promise<void> {
    const state = await this.loadState();
    const nowServerMs = Date.now();
    const next = reduce(state, cmd.c, { nowServerMs, memberId: session.memberId });
    if (next === state) return; // no-op command: nothing changed, nothing to broadcast

    await this.saveState(next);
    this.broadcast({
      t: 'state',
      epoch: next.epoch,
      serverMs: nowServerMs,
      patch: { nowPlaying: next.nowPlaying, members: next.members, options: next.options },
      by: { memberId: session.memberId, nick: session.nick },
      cause: cmd.c.k,
    });
  }

  // `progress` is advisory (docs/PROTOCOL.md §3): it never changes
  // authoritative position, and Phase 1 does not broadcast it to the room —
  // showing *other* members' sync status in a party panel is Phase 4. It's
  // still recorded so a future phase has real data to build that panel on,
  // and so the drift number is computed the same way it eventually will be:
  // server-observed, not self-reported.
  private async handleProgress(session: SessionMeta, msg: Progress): Promise<void> {
    const state = await this.loadState();
    const nowServerMs = Date.now();
    const expectedMs = state.nowPlaying ? currentPositionMs(state.nowPlaying, nowServerMs) : 0;
    const driftMs = msg.positionMs - expectedMs;

    const members = state.members.map((m) =>
      m.memberId === session.memberId
        ? {
            ...m,
            sync: {
              driftMs,
              lastSeenMs: nowServerMs,
              ...(msg.stalled ? { stalled: msg.stalled } : {}),
            },
          }
        : m
    );
    await this.saveState({ ...state, members });
  }
}
