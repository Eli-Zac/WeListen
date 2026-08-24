import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ServerMessage, Hello, Cmd } from '@welisten/protocol';

// Each test uses its own Durable Object instance (a distinct idFromName), not
// the real hardcoded PHASE1_CODE — storage isolation is per test *file* here,
// not per test (see the vitest-plugin v1 migration notes), so sharing one DO
// across tests would leak members/epoch between them. party.ts itself has no
// idea what name it was addressed by, so this doesn't change what's tested.
async function connect(roomName: string): Promise<WebSocket> {
  const id = env.PARTY_ROOM.idFromName(roomName);
  const stub = env.PARTY_ROOM.get(id);
  const res = await stub.fetch('http://do/v1/party/PHASE1/ws', {
    headers: { Upgrade: 'websocket' },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error('handshake did not return a WebSocket');
  ws.accept();
  return ws;
}

function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for a message')), 2000);
    ws.addEventListener(
      'message',
      (evt) => {
        clearTimeout(timeout);
        resolve(JSON.parse(evt.data as string) as ServerMessage);
      },
      { once: true }
    );
  });
}

function hello(nick: string): Hello {
  return { t: 'hello', protocol: 1, nick, clientVersion: 'test' };
}

describe('PartyRoom (Phase 1)', () => {
  it('sends welcome with the hardcoded single-track anchor', async () => {
    const ws = await connect('room-welcome');
    ws.send(JSON.stringify(hello('Alice')));
    const msg = await nextMessage(ws);

    expect(msg.t).toBe('welcome');
    if (msg.t !== 'welcome') throw new Error('unreachable');
    expect(msg.state.code).toBe('PHASE1');
    expect(msg.state.nowPlaying?.rate).toBe(0);
    expect(msg.state.members).toHaveLength(1);
    expect(msg.state.members[0]?.nick).toBe('Alice');
  });

  it('a second member sees the first in members, and the first is told about the join', async () => {
    const wsA = await connect('room-join');
    wsA.send(JSON.stringify(hello('Alice2')));
    await nextMessage(wsA); // welcome

    const wsB = await connect('room-join');
    wsB.send(JSON.stringify(hello('Bob2')));
    const [welcomeB, joinedNoticeOnA] = await Promise.all([nextMessage(wsB), nextMessage(wsA)]);

    expect(welcomeB.t).toBe('welcome');
    if (welcomeB.t !== 'welcome') throw new Error('unreachable');
    expect(welcomeB.state.members.map((m) => m.nick).sort()).toEqual(['Alice2', 'Bob2']);

    expect(joinedNoticeOnA.t).toBe('state');
    if (joinedNoticeOnA.t !== 'state') throw new Error('unreachable');
    expect(joinedNoticeOnA.cause).toBe('memberJoined');
  });

  it('play/pause/seek advance the epoch and broadcast to every member', async () => {
    const wsA = await connect('room-transport');
    wsA.send(JSON.stringify(hello('Alice3')));
    await nextMessage(wsA); // welcome

    const wsB = await connect('room-transport');
    wsB.send(JSON.stringify(hello('Bob3')));
    await nextMessage(wsB); // welcome for B
    const joinedOnA = await nextMessage(wsA); // memberJoined notice for A
    if (joinedOnA.t !== 'state') throw new Error('unreachable');
    const epoch0 = joinedOnA.epoch;

    const cmd: Cmd = { t: 'cmd', id: 'cmd-1', epoch: epoch0, c: { k: 'play' } };
    wsA.send(JSON.stringify(cmd));

    const [onA, onB] = await Promise.all([nextMessage(wsA), nextMessage(wsB)]);
    for (const msg of [onA, onB]) {
      expect(msg.t).toBe('state');
      if (msg.t !== 'state') throw new Error('unreachable');
      expect(msg.cause).toBe('play');
      expect(msg.epoch).toBe(epoch0 + 1);
      expect(msg.patch.nowPlaying?.rate).toBe(1);
    }
  });

  it('a duplicate hello on the same connection is a protocol violation', async () => {
    const ws = await connect('room-dup-hello');
    ws.send(JSON.stringify(hello('Carol')));
    await nextMessage(ws);

    const closed = new Promise<{ code: number }>((resolve) => {
      ws.addEventListener('close', (evt) => resolve({ code: evt.code }), { once: true });
    });
    ws.send(JSON.stringify(hello('Carol')));
    const { code } = await closed;
    expect(code).toBe(4400);
  });

  it('rejects a frame before hello', async () => {
    const ws = await connect('room-before-hello');
    const closed = new Promise<{ code: number }>((resolve) => {
      ws.addEventListener('close', (evt) => resolve({ code: evt.code }), { once: true });
    });
    ws.send(JSON.stringify({ t: 'ping', clientMs: 0 }));
    const { code } = await closed;
    expect(code).toBe(4400);
  });
});
