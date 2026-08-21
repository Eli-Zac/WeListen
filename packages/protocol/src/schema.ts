import { z } from 'zod';

// Wire protocol v1 — see docs/PROTOCOL.md. Single source of truth for both
// sides of the WebSocket: the inferred TS types below are what the extension
// and the Worker both compile against, so a change that breaks one breaks
// the other's typecheck in the same commit.

export const PROTOCOL_VERSION = 1;

// ---- shared value types ----------------------------------------------------

/** -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued. Mirrors #movie_player. */
export const PlayerStateSchema = z.union([
  z.literal(-1),
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(5),
]);
export type PlayerState = z.infer<typeof PlayerStateSchema>;

export const StalledReasonSchema = z.enum(['buffering', 'ad', 'unplayable']);
export type StalledReason = z.infer<typeof StalledReasonSchema>;

export const TrackMetaSchema = z.object({
  title: z.string(),
  artist: z.string(),
  durationMs: z.number().nonnegative(),
  artworkUrl: z.string().url().optional(),
});
export type TrackMeta = z.infer<typeof TrackMetaSchema>;

/**
 * Position is never a moving number — it is a statement about a moment that
 * already happened. Current position is derived: see currentPositionMs()
 * below. Pause is rate: 0, not a separate boolean. See docs/DECISIONS.md D5.
 */
export const AnchorSchema = z.object({
  itemId: z.string(),
  videoId: z.string(),
  positionMs: z.number(),
  atServerMs: z.number(),
  rate: z.number(),
});
export type Anchor = z.infer<typeof AnchorSchema>;

export const QueueItemSchema = z.object({
  itemId: z.string(),
  videoId: z.string(),
  order: z.string(), // fractional index key, e.g. "a0" < "a0V" < "a1"
  addedBy: z.string(),
  meta: TrackMetaSchema,
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

export const MemberSchema = z.object({
  memberId: z.string(),
  nick: z.string(),
  joinedAt: z.number(),
  sync: z.object({
    driftMs: z.number(),
    stalled: StalledReasonSchema.optional(),
    lastSeenMs: z.number(),
  }),
});
export type Member = z.infer<typeof MemberSchema>;

export const PartyOptionsSchema = z.object({
  waitForAll: z.boolean(),
  allowClear: z.boolean(),
});
export type PartyOptions = z.infer<typeof PartyOptionsSchema>;

export const PartyStateSchema = z.object({
  code: z.string(),
  epoch: z.number().int().nonnegative(),
  nowPlaying: AnchorSchema.nullable(),
  queue: z.array(QueueItemSchema),
  members: z.array(MemberSchema),
  options: PartyOptionsSchema,
});
export type PartyState = z.infer<typeof PartyStateSchema>;

// ---- commands (client intent) ----------------------------------------------

const NickSchema = z.string().trim().min(1).max(24);

export const CommandSchema = z.discriminatedUnion('k', [
  z.object({ k: z.literal('play') }),
  z.object({ k: z.literal('pause') }),
  z.object({ k: z.literal('seek'), positionMs: z.number().nonnegative() }),
  z.object({ k: z.literal('next') }),
  z.object({ k: z.literal('prev') }),
  z.object({ k: z.literal('jumpTo'), itemId: z.string() }),

  z.object({
    k: z.literal('add'),
    videoId: z.string(),
    meta: TrackMetaSchema,
    after: z.string().optional(),
  }),
  z.object({ k: z.literal('remove'), itemId: z.string() }),
  z.object({ k: z.literal('move'), itemId: z.string(), after: z.string().nullable() }),
  z.object({ k: z.literal('clear') }),

  z.object({ k: z.literal('rename'), nick: NickSchema }),
  z.object({
    k: z.literal('setOption'),
    option: z.enum(['waitForAll', 'allowClear']),
    value: z.boolean(),
  }),
]);
export type Command = z.infer<typeof CommandSchema>;
export type CommandKind = Command['k'];

// ---- client -> server -------------------------------------------------------

export const HelloSchema = z.object({
  t: z.literal('hello'),
  protocol: z.number().int(),
  nick: NickSchema,
  clientVersion: z.string(),
  resume: z
    .object({ memberId: z.string(), token: z.string(), epoch: z.number().int() })
    .optional(),
});
export type Hello = z.infer<typeof HelloSchema>;

export const PingSchema = z.object({ t: z.literal('ping'), clientMs: z.number() });
export type Ping = z.infer<typeof PingSchema>;

export const CmdSchema = z.object({
  t: z.literal('cmd'),
  id: z.string(),
  epoch: z.number().int().nonnegative(),
  c: CommandSchema,
});
export type Cmd = z.infer<typeof CmdSchema>;

export const ProgressSchema = z.object({
  t: z.literal('progress'),
  positionMs: z.number(),
  playerState: PlayerStateSchema,
  stalled: StalledReasonSchema.optional(),
});
export type Progress = z.infer<typeof ProgressSchema>;

export const ClientMessageSchema = z.discriminatedUnion('t', [
  HelloSchema,
  PingSchema,
  CmdSchema,
  ProgressSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---- server -> client -------------------------------------------------------

export const WelcomeSchema = z.object({
  t: z.literal('welcome'),
  memberId: z.string(),
  token: z.string(),
  serverMs: z.number(),
  epoch: z.number().int().nonnegative(),
  state: PartyStateSchema,
});
export type Welcome = z.infer<typeof WelcomeSchema>;

export const PongSchema = z.object({
  t: z.literal('pong'),
  clientMs: z.number(),
  serverMs: z.number(),
});
export type Pong = z.infer<typeof PongSchema>;

export const PartyStatePatchSchema = PartyStateSchema.partial();
export type PartyStatePatch = z.infer<typeof PartyStatePatchSchema>;

export const StateMsgSchema = z.object({
  t: z.literal('state'),
  epoch: z.number().int().nonnegative(),
  serverMs: z.number(),
  patch: PartyStatePatchSchema,
  full: z.literal(true).optional(),
  by: z.object({ memberId: z.string(), nick: z.string() }).optional(),
  cause: z
    .union([
      z.enum(['play', 'pause', 'seek', 'next', 'prev', 'jumpTo', 'add', 'remove', 'move', 'clear', 'rename', 'setOption']),
      z.enum(['trackEnded', 'memberJoined', 'memberLeft', 'autoSkip']),
    ])
    .optional(),
});
export type StateMsg = z.infer<typeof StateMsgSchema>;

export const NoticeSchema = z.object({
  t: z.literal('notice'),
  level: z.enum(['info', 'warn', 'error']),
  code: z.string(),
  message: z.string(),
});
export type Notice = z.infer<typeof NoticeSchema>;

export const ServerMessageSchema = z.discriminatedUnion('t', [
  WelcomeSchema,
  PongSchema,
  StateMsgSchema,
  NoticeSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ---- close codes ------------------------------------------------------------

export const CloseCode = {
  PROTOCOL_VIOLATION: 4400,
  NOT_FOUND: 4404,
  VERSION_UNSUPPORTED: 4409,
  RATE_LIMITED: 4429,
} as const;
