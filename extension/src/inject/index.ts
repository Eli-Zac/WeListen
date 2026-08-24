import {
  BRIDGE_CHANNEL,
  BridgeRequestSchema,
  InitSchema,
  type BridgeResponse,
} from '../shared/bridge-protocol.js';
import * as player from './player.js';

// MAIN world entry (docs/ARCHITECTURE.md §2). Registered at document_start so
// it can hook the player before the app boots, but it can't do anything
// authenticated until it receives the init nonce from ISOLATED — see
// shared/bridge-protocol.ts for why the handshake is shaped this way.

let lockedNonce: string | null = null;

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || event.origin !== location.origin) return;

  const data: unknown = event.data;
  if (!data || typeof data !== 'object') return;

  if (lockedNonce === null) {
    const init = InitSchema.safeParse(data);
    if (init.success) {
      lockedNonce = init.data.nonce;
    }
    return;
  }

  const req = BridgeRequestSchema.safeParse(data);
  if (!req.success) return;
  if (req.data.nonce !== lockedNonce) return; // not from our ISOLATED-world counterpart

  handleRequest(req.data.id, req.data.method, req.data.params);
});

function respond(id: string, ok: boolean, result?: unknown, error?: string): void {
  if (lockedNonce === null) return;
  const msg: BridgeResponse = { channel: BRIDGE_CHANNEL, nonce: lockedNonce, kind: 'response', id, ok, result, error };
  window.postMessage(msg, location.origin);
}

function handleRequest(id: string, method: string, params: unknown): void {
  try {
    switch (method) {
      case 'getPlayerState':
        respond(id, true, player.getSnapshot());
        return;
      case 'play':
        player.play();
        respond(id, true);
        return;
      case 'pause':
        player.pause();
        respond(id, true);
        return;
      case 'seekTo': {
        const positionMs = (params as { positionMs?: number } | undefined)?.positionMs;
        if (typeof positionMs !== 'number') {
          respond(id, false, undefined, 'seekTo requires positionMs');
          return;
        }
        player.seekTo(positionMs);
        respond(id, true);
        return;
      }
      case 'setPlaybackRate': {
        const rate = (params as { rate?: number } | undefined)?.rate;
        if (typeof rate !== 'number') {
          respond(id, false, undefined, 'setPlaybackRate requires rate');
          return;
        }
        player.setPlaybackRate(rate);
        respond(id, true);
        return;
      }
      default:
        respond(id, false, undefined, `unknown method: ${method}`);
    }
  } catch (err) {
    respond(id, false, undefined, String(err));
  }
}
