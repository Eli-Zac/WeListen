import { z } from 'zod';

// The MAIN <-> ISOLATED bridge (docs/ARCHITECTURE.md §2). window.postMessage
// is the only channel, and it's shared with the page and every other
// extension installed — so every message after the handshake carries a
// per-page-load nonce, and everything is schema-validated on receipt. The
// MAIN world is a hostile environment: treat anything arriving from it as
// untrusted input.

export const BRIDGE_CHANNEL = 'welisten-bridge';
export const INIT_CHANNEL = 'welisten-init';

/**
 * Sent once, from ISOLATED to MAIN, to hand over the nonce that authenticates
 * every later message. MAIN is registered at document_start (so it can hook
 * the player before the app boots) and simply buffers/no-ops until this
 * arrives; ISOLATED sends it as early as it can (document_idle). The first
 * well-formed init MAIN receives from its own window at its own origin wins
 * and is locked in — a further init is ignored, which bounds the handshake
 * to a narrow race at page load rather than an ongoing attack surface.
 */
export const InitSchema = z.object({
  channel: z.literal(INIT_CHANNEL),
  nonce: z.string().min(16),
});
export type Init = z.infer<typeof InitSchema>;

export const BridgeMethodSchema = z.enum([
  'getPlayerState',
  'play',
  'pause',
  'seekTo',
  'setPlaybackRate',
]);
export type BridgeMethod = z.infer<typeof BridgeMethodSchema>;

export const BridgeRequestSchema = z.object({
  channel: z.literal(BRIDGE_CHANNEL),
  nonce: z.string(),
  kind: z.literal('request'),
  id: z.string(),
  method: BridgeMethodSchema,
  params: z.unknown().optional(),
});
export type BridgeRequest = z.infer<typeof BridgeRequestSchema>;

export const BridgeResponseSchema = z.object({
  channel: z.literal(BRIDGE_CHANNEL),
  nonce: z.string(),
  kind: z.literal('response'),
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type BridgeResponse = z.infer<typeof BridgeResponseSchema>;

export const BridgeEventSchema = z.object({
  channel: z.literal(BRIDGE_CHANNEL),
  nonce: z.string(),
  kind: z.literal('event'),
  event: z.enum(['trackChanged']),
  data: z.unknown().optional(),
});
export type BridgeEvent = z.infer<typeof BridgeEventSchema>;

export const BridgeMessageSchema = z.union([BridgeRequestSchema, BridgeResponseSchema, BridgeEventSchema]);
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;

/** Result shape of the player-adapter methods exposed over the bridge. */
export interface PlayerStateSnapshot {
  present: boolean;
  currentTimeMs: number | null;
  playerState: number | null;
  videoId: string | null;
  playbackRate: number | null;
}
