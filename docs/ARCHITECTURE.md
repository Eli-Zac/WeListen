# Architecture

## 1. The central problem

Everything else in this project is easy. The hard part is this:

> YouTube Music is a closed, undocumented, frequently-redesigned Polymer application, and we
> need to read and write its playback state and its queue from outside it, reliably, on
> other people's machines, for years.

Two consequences shape every decision below.

**Consequence one: isolate the brittleness.** Every line of code that touches a YouTube
Music internal — a DOM selector, a Redux action type, an InnerTube field name — lives in one
directory (`extension/src/inject/`) behind a stable interface. When Google reshuffles the
app, we fix one adapter, not the whole extension. Nothing outside that directory may
reference a `ytmusic-*` element or a `#movie_player` method.

**Consequence two: never trust a client's sense of time.** Each participant's player is
subject to buffering, ad breaks, a throttled background tab, and a wall clock that may be
seconds off. The server holds the truth; clients continuously measure their own error
against it and correct. This is [`docs/SYNC.md`](SYNC.md).

---

## 2. Three worlds, one tab

A Chrome extension on a page like YouTube Music actually runs in three separate JavaScript
environments, and the split is not optional — it is imposed by the browser. Understanding
it is most of understanding this codebase.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ MAIN world  ·  extension/src/inject/                                         │
│                                                                              │
│ Shares the page's JS heap. This is the ONLY place that can call              │
│ #movie_player.seekTo() or read ytmusic-app.store.getState().                 │
│ Has no access to chrome.* APIs. Assume everything here can break on any      │
│ YouTube Music deploy — so keep it thin, defensive, and feature-detected.     │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │  window.postMessage, origin- and token-checked
┌───────────────────────────────┴──────────────────────────────────────────────┐
│ ISOLATED world  ·  extension/src/content/                                    │
│                                                                              │
│ Sees the same DOM but a separate JS heap — page scripts cannot touch our      │
│ variables. Owns all injected UI: the nav-bar button, the party panel, the    │
│ queue badges. Has chrome.runtime, so it talks to the service worker.         │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │  chrome.runtime long-lived Port
┌───────────────────────────────┴──────────────────────────────────────────────┐
│ SERVICE WORKER  ·  extension/src/background/                                 │
│                                                                              │
│ One per browser, not per tab. Holds the single WebSocket to the party,       │
│ owns the clock-offset estimate, and survives YouTube Music's SPA navigation. │
│ Never touches the DOM.                                                       │
└──────────────────────────────────────────────────────────────────────────────┘
                                │  wss://
                                ▼
                    Cloudflare Worker → PartyRoom Durable Object
```

Manifest V3 can register a MAIN-world content script directly, so we do not need the old
`script` tag injection hack:

```jsonc
"content_scripts": [
  { "matches": ["https://music.youtube.com/*"], "world": "MAIN",
    "js": ["inject.js"],  "run_at": "document_start" },
  { "matches": ["https://music.youtube.com/*"], "world": "ISOLATED",
    "js": ["content.js"], "run_at": "document_idle" }
]
```

`document_start` for the MAIN-world script matters: it lets us hook things before the
YouTube Music app boots, rather than racing it.

### The bridge between MAIN and ISOLATED

`window.postMessage` is the only channel, and it is shared with the page and with every
other extension the user has installed. So:

- Every message carries a per-page-load random nonce, generated in the ISOLATED world and
  handed to the MAIN world at injection time. Messages without it are dropped silently.
- Every message is validated against a schema on receipt. The MAIN world is a hostile
  environment; treat anything arriving from it as untrusted input, because a malicious page
  script could forge it.
- The bridge is request/response with correlation IDs plus a separate event stream, so
  `getPlayerState()` can be awaited but `trackChanged` can arrive unprompted.

---

## 3. Where the WebSocket lives

**Decision: the service worker holds it.** One connection per browser, and it survives the
user navigating around YouTube Music's SPA and opening or closing tabs.

The known risk is MV3 service worker lifetime — Chrome terminates idle workers. Two
mitigations, in order:

1. A 20-second application-level heartbeat. WebSocket traffic counts as activity and resets
   Chrome's idle timer, so an active party keeps its own worker alive.
2. If the Phase 0 spike shows the worker still being killed during long quiet stretches
   (a paused party, say), move the connection into an **offscreen document**, which has no
   such lifetime limit. The connection layer is written behind an interface specifically so
   this swap is a one-file change.

A rejected alternative was holding the socket in the content script. It sidesteps the
lifetime problem entirely, but then two open YouTube Music tabs mean two connections and two
competing players, and solving *that* needs a leader election between tabs — more moving
parts than the offscreen fallback.

### Multiple tabs

Only one tab may drive the player. The service worker designates the first YouTube Music tab
that connects as the **active tab**; others render the party panel in a read-only "playing in
another tab" state with a button to take over. This is bookkeeping in the service worker, not
a distributed algorithm, because the service worker already sees every tab.

---

## 4. Reaching into YouTube Music

All of this lives in `extension/src/inject/` behind the interfaces below. **The exact
selectors and internal APIs named here are our current best understanding and must be
verified in the Phase 0 spike before anything is built on them.** They are undocumented and
Google changes them without notice.

### 4.1 Playback — `inject/player.ts`

YouTube Music embeds the standard YouTube player. `document.querySelector('#movie_player')`
is expected to expose the familiar imperative API:

```ts
interface YtmPlayer {
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  getCurrentTime(): number          // seconds, fractional
  getDuration(): number
  getPlayerState(): number          // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
  getVideoData(): { video_id: string, title: string, author: string }
  setPlaybackRate(rate: number): void
  getPlaybackRate(): number
}
```

`setPlaybackRate` is what makes smooth correction possible — see [`docs/SYNC.md`](SYNC.md).
Confirm in the spike that YouTube Music permits rates other than 1.0 and that fine-grained
values (1.02) are honoured rather than snapped to a preset list. If they are snapped, the
sync algorithm falls back to seek-only correction, which is audible but workable.

`getCurrentTime()` is polled at ~4 Hz for local state and reported to the server at 1 Hz.
Polling, not events: the player's own time-update events are inconsistent and we want a
predictable sampling interval for the drift filter.

### 4.2 The queue — `inject/queue.ts`

This is the least certain area and the one that most needs the spike. Three candidate
approaches, in preference order:

**(a) Drive YouTube Music's own store.** `document.querySelector('ytmusic-app')` is expected
to carry a Redux-like `store` with `getState()`, `subscribe()`, and `dispatch()`, with the
queue at roughly `state.queue.items` as an array of `playlistPanelVideoRenderer` objects.
Reading it is almost certainly viable and is how we mirror the native queue into our UI.
*Writing* to it — dispatching add/remove/reorder actions — is the open question, because it
means depending on internal action type strings.

Why this is preferred anyway: it is the only approach that satisfies the actual requirement,
which is a queue that is **natively** synced. The user sees YouTube Music's real queue panel,
with real drag handles and real up-next behaviour, and it happens to be shared.

**(b) Rebuild the queue as a real YouTube Music playlist.** Create an unlisted playlist via
InnerTube, keep it as the party queue, and have every client load
`watch?v=<current>&list=<partyPlaylistId>`. Native queue UI for free, with no internal action
types involved. Costs: a playlist write on every queue change (~300ms), the playlist lives on
one person's account, and it leaves debris in their library. A strong fallback.

**(c) Extension-owned queue, track-by-track driving.** WeListen holds the queue; on track
change we call `loadVideoById(nextId)`. Robust and almost unbreakable, but YouTube Music's own
queue panel shows only the current song, so the queue lives entirely in our injected UI. This
is the safety net — it will always work, and it is the least native.

Build (c) first as the reference implementation and the permanent fallback, then attempt (a)
on top of it. The queue interface is written so the three are interchangeable:

```ts
interface QueueAdapter {
  read(): Promise<QueueSnapshot>
  applyIntent(intent: QueueIntent): Promise<void>   // add | remove | move | jumpTo
  observe(cb: (snapshot: QueueSnapshot) => void): Unsubscribe
  readonly nativeness: 'native' | 'playlist' | 'shadow'
}
```

Ship whichever adapter passes its capability probe at runtime, and report which one is active
in the party panel's debug view. A user on a broken YouTube Music build degrades to a working
extension instead of a dead one.

### 4.3 Track metadata and search — `inject/innertube.ts`

To add "the song Bob just picked" to Alice's queue, all we need to transmit is the video ID —
both clients resolve it against YouTube Music themselves. For search-and-add, and for
resolving titles and artwork, we use the same InnerTube endpoints the page already uses,
with credentials and API key read from the page's `ytcfg`. These calls originate from the
page context, on the user's own session, exactly as if they had clicked — we add no traffic
pattern the site does not already produce.

### 4.4 Surviving the SPA

YouTube Music never does a full page load. Our mount points get destroyed and recreated as
the user navigates. Handling:

- A `MutationObserver` on `document.body` re-mounts injected UI whenever its anchor
  disappears, debounced with `requestAnimationFrame`.
- Listen for `yt-navigate-finish` (and `yt-page-data-updated`) to re-read context.
- Every mount is idempotent and keyed by a `data-welisten` attribute, so a double-fire
  cannot produce two buttons.

---

## 5. Injected UI

Three surfaces, all in `extension/src/content/ui/`:

1. **Nav bar entry point.** A "Listen Party" button beside the existing top-right controls.
   Not in a party: opens a start/join popover. In a party: shows a live member count and a
   coloured dot for connection health.
2. **Party panel.** A side panel matching YouTube Music's own panel geometry — member list
   with per-member sync status, the shared queue, an invite link with copy button, and a
   leave button.
3. **Player-bar affordances.** A small badge on the player bar showing that playback is
   party-controlled, plus a transient toast when someone else acts ("Bob skipped to *Song*").
   The toast matters more than it sounds: without attribution, a remote skip feels like a bug.

Styling reuses YouTube Music's CSS custom properties (`--ytmusic-*`, `--yt-spec-*`) rather
than hardcoded colours, so the extension follows the app's theme, including any future
redesign, for free. Everything is rendered into a **shadow root** to guarantee our styles
cannot leak into the app and the app's cannot leak into ours.

Accessibility is not optional here: injected controls need real `aria-label`s, keyboard
focus order that fits the surrounding page, and a visible focus ring.

---

## 6. Server

A Cloudflare Worker for routing and one **Durable Object per party**. Durable Objects give
exactly the primitive this problem needs: a single-threaded, addressable, consistent object
that all members of one room connect to. There is no cross-instance coordination problem
because there is only ever one instance per party code.

```
POST /v1/party                 → create; returns { code, wsUrl }
GET  /v1/party/:code           → probe existence and member count (for join validation)
GET  /v1/party/:code/ws        → WebSocket upgrade; routed to that party's Durable Object
```

Inside the Durable Object:

- **WebSocket Hibernation API**, so an idle party costs nothing while remaining instantly
  resumable. This is the reason the hosting bill for a long tail of small rooms stays near
  zero.
- **Authoritative state** in memory, mirrored to DO storage on every mutation so a party
  survives eviction: the ordered queue, the now-playing anchor, and the member list.
- **A single reducer.** Every state change — from a member command or from the passage of
  time — goes through one pure function, `reduce(state, command, serverTime) → state`. The
  Durable Object's single-threaded execution makes this a total order for free, which is what
  makes the "everyone has equal control" model tractable at all: concurrent commands do not
  race, they queue.
- **Monotonic `epoch`** incremented on every accepted command. Clients discard any state
  update with an epoch lower than one they have already applied, which makes out-of-order
  delivery and reconnect races harmless.

Position is never stored as a moving number. It is stored as an anchor — *"video X was at
42.0s as of server time T, playing at rate 1.0"* — and any observer computes the current
position from it. A paused party stores the same anchor with `rate: 0`. This one
representational choice removes an entire category of drift bug.

Queue ordering uses **fractional index keys** (LexoRank-style strings) rather than array
positions, so two people inserting simultaneously produce a deterministic order instead of
clobbering each other, and a move is a single key rewrite rather than a whole-list rewrite.

---

## 7. Repository layout

```
WeListen/
├── extension/
│   ├── manifest.config.ts          # manifest generated from TS, versioned with package.json
│   ├── vite.config.ts
│   ├── src/
│   │   ├── background/
│   │   │   ├── index.ts            # service worker entry, port fan-out to tabs
│   │   │   ├── connection.ts       # WS lifecycle, backoff, heartbeat  (swappable → offscreen)
│   │   │   ├── clock.ts            # offset/RTT estimation, see docs/SYNC.md
│   │   │   ├── session.ts          # party state machine: idle → joining → live → reconnecting
│   │   │   └── tabs.ts             # active-tab designation
│   │   ├── content/
│   │   │   ├── index.ts            # entry: mount, connect port, wire bridge
│   │   │   ├── mount.ts            # SPA-resilient anchor observation
│   │   │   ├── bridge.ts           # ISOLATED ⇄ MAIN, nonce-authenticated
│   │   │   └── ui/                 # nav-button, party-panel, queue-list, toast (shadow DOM)
│   │   ├── inject/                 # ← ALL YouTube Music coupling lives here, and only here
│   │   │   ├── index.ts            # capability probe + bridge server
│   │   │   ├── player.ts           # #movie_player adapter
│   │   │   ├── queue/              # native.ts | playlist.ts | shadow.ts + adapter selection
│   │   │   ├── innertube.ts        # ytcfg-derived API calls (search, metadata)
│   │   │   └── selectors.ts        # every DOM selector in the project, in one file
│   │   ├── popup/                  # toolbar popup: status, start/join, settings
│   │   └── shared/                 # re-exports from packages/protocol, constants, logger
│   └── tests/
│       ├── unit/
│       └── e2e/                    # Playwright + real Chromium, two profiles, real YTM
├── server/
│   ├── wrangler.toml
│   └── src/
│       ├── index.ts                # Worker: routing, party creation, rate limits
│       ├── party.ts                # PartyRoom Durable Object
│       ├── reduce.ts               # the single pure reducer  (shared with client)
│       ├── ordering.ts             # fractional index keys
│       └── codes.ts                # unambiguous room-code alphabet + collision handling
├── packages/
│   └── protocol/                   # zod schemas + inferred TS types, versioned wire format
├── docs/
└── tools/
    └── probe/                      # Phase 0 spike: bookmarklet + report for YTM internals
```

`packages/protocol` being shared by both sides is deliberate: the wire format is defined
once, and a change that breaks the server breaks the client's typecheck in the same commit.
`reduce.ts` is likewise shared, which lets the client predict the server's response to its own
command and apply it optimistically — see [`docs/PROTOCOL.md`](PROTOCOL.md) §5.

---

## 8. Failure modes we design for, not against

These are not edge cases. Each of them will happen to real users within an hour of launch.

| Situation | Behaviour |
| --- | --- |
| **Ad break** (non-Premium listener) | Detected via player state plus the ad DOM markers. That client reports `stalled: ad`, keeps its socket open, and is shown as "in an ad" to the room. It hard-seeks back to the party position when the ad ends. The party does **not** stop for one person's ad — a mixed Premium/free room would never play otherwise. A room setting can opt into "wait for everyone" instead. |
| **Buffering** | Reported as `stalled: buffering`. Below ~2s the drift controller absorbs it; beyond that the client hard-seeks on recovery. |
| **Track unavailable in a region / age-gated** | The client reports `unplayable`. If a quorum reports it, the party auto-skips and toasts why. A single affected member is skipped past locally and marked out-of-sync rather than stranding the room. |
| **Network drop** | Exponential backoff with jitter, capped at 30s. On reconnect the client sends its last-known epoch and receives either a delta or a full state snapshot. The UI shows "reconnecting", never silently stale state. |
| **Tab throttled in background** | Chrome throttles timers in background tabs, so the drift loop degrades. Detected via `document.visibilityState`; on refocus, hard-resync rather than trusting accumulated local state. |
| **Everyone leaves** | The Durable Object persists briefly, then expires. Rejoining an expired code returns a clean "this party has ended". |
| **YouTube Music ships a redesign** | Capability probes fail at mount, the queue adapter degrades to `shadow`, and if even the player adapter fails the extension shows an honest "WeListen needs an update" instead of half-working. |

---

## 9. Security and privacy posture

- **No accounts, no PII.** A member is a nickname and a random session ID. Nothing is
  retained after a party ends.
- **Room codes are capability tokens.** Anyone with the code can join, so codes come from a
  CSPRNG over an unambiguous alphabet (no `0`/`O`, `1`/`I`/`l`) with enough entropy to make
  enumeration pointless, plus per-IP creation and join rate limits at the Worker.
- **Every inbound message is schema-validated on both ends.** The server treats clients as
  hostile; the ISOLATED world treats the MAIN world as hostile.
- **Minimal permissions.** `host_permissions` limited to `https://music.youtube.com/*` and
  the single API origin. No `tabs`, no `<all_urls>`, no `scripting` if the static manifest
  registration is sufficient. Every permission we request must be defensible in one sentence
  during Chrome Web Store review, because we will be asked.
- **No remote code, ever.** All logic ships in the package. This is a Web Store hard rule and
  the single most common cause of rejection.
- **We never touch the user's Google credentials.** InnerTube calls ride the page's existing
  session in the page's own context; the extension neither reads nor transmits cookies or
  tokens.
- **Content Security Policy** on the extension pages, and no `innerHTML` with any value that
  came off the wire — remote nicknames and track titles are set via `textContent`.
