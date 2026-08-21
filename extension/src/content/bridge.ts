import {
  BRIDGE_CHANNEL,
  BridgeResponseSchema,
  INIT_CHANNEL,
  type BridgeMethod,
  type Init,
} from '../shared/bridge-protocol.js';
import { makeLogger } from '../shared/logger.js';

const log = makeLogger('bridge');

// ISOLATED-world side of the MAIN <-> ISOLATED bridge (docs/ARCHITECTURE.md
// §2). Generates the nonce, hands it to MAIN, and exposes a small
// request/response client on top of window.postMessage.

const nonce = crypto.randomUUID();
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> }>();

function sendInit(): void {
  const msg: Init = { channel: INIT_CHANNEL, nonce };
  window.postMessage(msg, location.origin);
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data: unknown = event.data;
  if (!data || typeof data !== 'object') return;

  const res = BridgeResponseSchema.safeParse(data);
  if (!res.success) return;
  if (res.data.nonce !== nonce) return;

  const waiter = pending.get(res.data.id);
  if (!waiter) return;
  pending.delete(res.data.id);
  clearTimeout(waiter.timeout);
  if (res.data.ok) waiter.resolve(res.data.result);
  else waiter.reject(new Error(res.data.error ?? 'bridge request failed'));
});

// Re-send init a few times in case MAIN's listener wasn't attached yet on the
// very first attempt (it should be, given document_start, but this costs
// nothing and removes a class of startup race).
sendInit();
setTimeout(sendInit, 50);
setTimeout(sendInit, 250);

export function call<T = unknown>(method: BridgeMethod, params?: unknown, timeoutMs = 2000): Promise<T> {
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`bridge call '${method}' timed out`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timeout });
    window.postMessage({ channel: BRIDGE_CHANNEL, nonce, kind: 'request', id, method, params }, location.origin);
  }).catch((err) => {
    log.warn('bridge call failed', method, err);
    throw err;
  });
}
