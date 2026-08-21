# Wire protocol

Version `1`. Defined once in `packages/protocol` as zod schemas with TypeScript types
inferred from them, and imported by both the extension and the Worker — so the wire format
cannot drift between the two sides without a typecheck failure in the same commit.

Transport is a single WebSocket per browser. Messages are JSON. Every message has a `t`
(type) discriminant.

---

## 1. Vocabulary

| Term | Meaning |
| --- | --- |
| **Party** | A room, addressed by a 6-character code. One Durable Object instance. |
| **Member** | One connected client. A nickname plus a server-issued `memberId`. |
| **Command** | A client's *intent*. Never authoritative — a request the server may reject. |
| **Epoch** | Monotonic counter, incremented by the server on every accepted command. |
| **Anchor** | How position is represented: `{ videoId, positionMs, atServerMs, rate }`. |
| **Server time** | Milliseconds since epoch on the Durable Object. The only clock that matters. |

The single most important rule in this document: **clients send intent, servers send truth.**
A client that presses pause does not pause. It asks to pause, and pauses when told to.
(It may *predict* the pause — see §5 — but the prediction is provisional.)

---

## 2. Connection lifecycle

```
client                                                    PartyRoom DO
  │                                                             │
  ├─── GET /v1/party/:code/ws  (Upgrade: websocket) ───────────►│
  │                                                             │
  ├─── hello { nick, clientVersion, protocol: 1, resume? } ─────►│
  │                                                             │
  │◄── welcome { memberId, serverMs, state, epoch } ─────────────┤
  │                                                             │
  ├─── ping { clientMs } ───────────────────────────────────────►│   ×5, then every 20s
  │◄── pong { clientMs, serverMs } ─────────────────────────────┤   (see docs/SYNC.md)
  │                                                             │
  ├─── cmd { id, ... } ─────────────────────────────────────────►│
  │◄── state { epoch, patch, by, cause } ───────── broadcast ────┤
  │                                                             │
  ├─── progress { positionMs, playerState, stalled? } ──────────►│   every 1s
  │                                                             │
```

`hello` must be the first frame. A connection that sends anything else first is closed with
`4400`. If `hello` carries `resume: { memberId, token, epoch }` from a previous connection,
the server restores that member's identity and sends a delta from `epoch` rather than a full
snapshot — so a reconnect does not make the member appear to leave and rejoin.

### Close codes

| Code | Meaning | Client behaviour |
| --- | --- | --- |
| `4400` | Malformed frame or protocol violation | Do not retry; surface a bug report |
| `4404` | No such party, or it has ended | Show "this party has ended", exit the party |
| `4409` | Protocol version unsupported | Prompt the user to update the extension |
| `4429` | Rate limited | Back off with the `retryAfterMs` in the close reason |
| `1001`/`1006` | Ordinary drop | Reconnect with backoff + jitter, then `resume` |

---

## 3. Client → server

### `hello`
```ts
{ t: 'hello', protocol: 1, nick: string,          // 1..24 chars, trimmed, server-sanitised
  clientVersion: string,
  resume?: { memberId: string, token: string, epoch: number } }
```

### `ping`
```ts
{ t: 'ping', clientMs: number }
```
Sent five times rapidly on connect to seed the clock estimate, then every 20s — which
doubles as the keepalive that holds the MV3 service worker open.

### `cmd` — the one message that changes anything

Every mutation is a `cmd` with a client-generated `id` (a UUID). The `id` exists so the
client can recognise the echo of its own command in the broadcast and reconcile its optimistic
prediction, and so a command replayed after a reconnect is idempotent.

```ts
{ t: 'cmd', id: string, epoch: number, /* the epoch the client believed when it acted */
  c: Command }

type Command =
  // ── transport ────────────────────────────────────────────────────────────
  | { k: 'play' }
  | { k: 'pause' }
  | { k: 'seek',  positionMs: number }
  | { k: 'next' }
  | { k: 'prev' }
  | { k: 'jumpTo', itemId: string }            // play a specific queue item now

  // ── queue ────────────────────────────────────────────────────────────────
  | { k: 'add',    videoId: string, meta: TrackMeta, after?: string }
  | { k: 'remove', itemId: string }
  | { k: 'move',   itemId: string, after: string | null }   // null = to the front
  | { k: 'clear' }

  // ── room ─────────────────────────────────────────────────────────────────
  | { k: 'rename', nick: string }
  | { k: 'setOption', option: 'waitForAll' | 'allowClear', value: boolean }
```

`epoch` is advisory, not a compare-and-swap. The server does not reject a stale-epoch command —
in a room where everyone has equal control, rejecting "pause" because someone else added a
song a moment earlier would be baffling. It is used for two narrower purposes: to detect that a
client acted on materially stale state (and log it), and for `move`, where a reorder computed
against an old list order is re-derived against the current one.

`meta` is included on `add` so the room can render the queue immediately, before any client
resolves the video ID. It is a convenience, not a source of truth — each client resolves the
real track itself.

### `progress`
```ts
{ t: 'progress', positionMs: number, playerState: PlayerState,
  stalled?: 'buffering' | 'ad' | 'unplayable' }
```
Sent every second. **This never changes the authoritative position.** It exists so the room
can display who is in sync, so ad and buffering states are visible to others, and so a quorum
of `unplayable` can trigger an auto-skip. A client whose position drifts is corrected, not
deferred to.

---

## 4. Server → client

### `welcome`
```ts
{ t: 'welcome', memberId: string, token: string, serverMs: number,
  epoch: number, state: PartyState }
```

### `pong`
```ts
{ t: 'pong', clientMs: number, serverMs: number }
```
`clientMs` is echoed verbatim so the client can compute round-trip time without keeping a
table of outstanding pings.

### `state` — the only message that conveys truth
```ts
{ t: 'state', epoch: number, serverMs: number,
  patch: Partial<PartyState>,          // or full snapshot when `full: true`
  full?: true,
  by?: { memberId: string, nick: string },   // who caused this, for attribution toasts
  cause?: Command['k'] | 'trackEnded' | 'memberJoined' | 'memberLeft' | 'autoSkip' }
```

Clients **must** discard any `state` whose `epoch` is not greater than the last one applied.
This makes out-of-order delivery, duplicate delivery, and reconnect races harmless without
any further reasoning.

`by` and `cause` are what let the UI say "Bob skipped to *Song*" instead of silently
teleporting the listener, which is the difference between a feature and a bug report.

### `notice`
```ts
{ t: 'notice', level: 'info' | 'warn' | 'error', code: string, message: string }
```
Non-fatal, user-presentable: rate-limit warnings, "that track appears unavailable for
Priya", "this party has been quiet for 30 minutes and will close soon".

---

## 5. Party state

```ts
interface PartyState {
  code: string
  epoch: number
  nowPlaying: Anchor | null
  queue: QueueItem[]           // ordered by `order`, ascending
  members: Member[]
  options: { waitForAll: boolean, allowClear: boolean }
}

interface Anchor {
  itemId: string
  videoId: string
  positionMs: number           // position AT `atServerMs` — not "now"
  atServerMs: number
  rate: number                 // 0 = paused. Not a boolean: a paused anchor is just rate 0.
}

interface QueueItem {
  itemId: string               // stable, server-issued; survives reorders
  videoId: string
  order: string                // fractional index key, e.g. "a0" < "a0V" < "a1"
  addedBy: string              // memberId
  meta: TrackMeta
}

interface TrackMeta { title: string, artist: string, durationMs: number, artworkUrl?: string }

interface Member {
  memberId: string
  nick: string
  joinedAt: number
  sync: { driftMs: number, stalled?: 'buffering' | 'ad' | 'unplayable', lastSeenMs: number }
}
```

### Why position is an anchor and not a number

A naive design stores `positionMs` and updates it. Then every network hop, every reconnect,
and every moment the server spends not running its timer becomes a source of accumulated
error, and pause/resume has to carefully stop and restart an accumulator.

An anchor cannot drift, because it does not move. It is a statement about a moment that has
already happened. Current position is a *derived* quantity:

```ts
const currentPositionMs = (a: Anchor, nowServerMs: number) =>
  a.positionMs + (nowServerMs - a.atServerMs) * a.rate
```

Pause writes a new anchor with `rate: 0` and the position at that instant. Resume writes one
with `rate: 1`. Seek writes one with the new position. There is exactly one code path, and it
is three lines long.

### Optimistic application

`reduce.ts` is shared between server and client. On sending a command, the client applies
`reduce(localState, cmd, estimatedServerMs)` immediately so the UI responds instantly, and
tags the result as provisional. When the authoritative `state` for that command's `id`
arrives, the provisional layer is dropped and the server's version applied. If the server's
result differs — because someone else's command landed first — the client snaps to the
server's version. It may briefly look like a flicker; it will never be *wrong*.

Only queue and transport commands are applied optimistically. Nothing that involves another
member is predicted.

---

## 6. Concurrency, with everyone holding the aux cord

The room model is that any member can do anything. That makes ordering, not permission, the
whole problem — and the Durable Object solves most of it by construction: it is
single-threaded, so commands from every member arrive at one reducer in one total order.
There are no lost updates and no lock.

What remains is that a strict last-write-wins order is occasionally *unpleasant*, so:

- **Queue inserts** use fractional index keys. Two people adding at the same moment produce
  two items in a deterministic order rather than one overwriting the other's position.
- **Seek and skip storms** are damped. Repeated transport commands from the same member
  within 400ms collapse to the last one, and the room applies at most one transport change
  per 250ms. Two people fighting over the scrubber produce one winner per window instead of a
  seizure. Both still see attribution toasts, which resolves the argument socially — which is
  the correct layer for it.
- **`next` is idempotent per track.** A `next` command carries the `itemId` the sender
  believed was playing. If that item is no longer current, the command has already been
  satisfied by someone else and is dropped. Without this, three people pressing skip at once
  skips three songs, which is the single most common bug in every listen-party product.
- **`clear`** is the one destructive command, gated behind the `allowClear` room option
  (default on for small rooms) and always attributed.

---

## 7. Versioning

`protocol: 1` in `hello`. The server accepts a documented range. Adding an optional field or
a new `notice` code is backward-compatible and needs no bump; changing the meaning of a field,
removing one, or altering `Anchor` semantics is a bump. Because extensions update on Chrome's
schedule and not ours, the server must speak version N-1 for at least 30 days after shipping
N, and old clients get a `notice` prompting an update rather than a hard disconnect.
