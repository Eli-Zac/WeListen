# Roadmap

Seven phases. Each has an explicit exit criterion, because the failure mode on a project like
this is drifting between half-finished layers.

Phase 0 is a genuine gate. If YouTube Music's internals do not support the primitives we need,
several decisions in [`ARCHITECTURE.md`](ARCHITECTURE.md) change — and it is far cheaper to
learn that in a two-day spike than in week five.

---

## Phase 0 — Spike: what does YouTube Music actually let us do?

**Throwaway code.** A bookmarklet and a scratch extension in `tools/probe/`, plus a written
report committed to `docs/probe-findings.md`. Nothing from this phase ships.

Questions to answer, in priority order:

1. Does `#movie_player` expose `seekTo`, `getCurrentTime`, `getPlayerState`, `getVideoData`,
   `loadVideoById`? What is the actual resolution and jitter of `getCurrentTime()`?
2. **Does `setPlaybackRate()` honour fine-grained values like 1.02, or snap to presets?**
   This single answer decides whether [`SYNC.md`](SYNC.md) §3 ships as designed or falls back
   to a seek-only controller.
3. Is there a `store` on `ytmusic-app`? Can we read the queue from it? Can we `subscribe()` to
   changes? **Can we `dispatch()` a queue mutation that the UI honours** — and what are the
   action type strings?
4. What is the real cost of a seek: latency, re-buffer probability, overshoot distribution?
5. Which DOM anchors are stable enough to mount UI into, and how do they behave across SPA
   navigation? Record them all in one place — they become `inject/selectors.ts`.
6. How are ads detectable from the page? What does the player report during one?
7. Can we read `ytcfg` for InnerTube search, and does a search request from page context
   succeed on the user's own session?

**Exit criterion:** `docs/probe-findings.md` answers all seven, and Q2 and Q3 have a
definite yes or no. If Q3's write path is a no, `ARCHITECTURE.md` §4.2 is amended to make the
playlist-backed adapter the primary path before Phase 3 begins.

---

## Phase 1 — Skeleton: two browsers, one song, no UI

The riskiest thing after the spike is the sync loop, so build it before anything that makes it
look nice.

- Monorepo, TypeScript, Vite, `packages/protocol` with zod schemas.
- MV3 manifest, three-world scaffolding, the MAIN⇄ISOLATED bridge with nonce authentication.
- Cloudflare Worker + `PartyRoom` Durable Object with WebSocket hibernation.
- The clock estimator and the drift controller.
- The debug overlay from [`SYNC.md`](SYNC.md) §7 — **built now, not later.**
- Hardcode a single party code and a single track. No queue, no join flow, no styling.

**Exit criterion:** two Chrome profiles on two machines play the same track with p95 drift
under 150 ms for ten minutes, including a deliberate network drop and recovery, with the drift
plot to prove it.

---

## Phase 2 — Parties: create, join, leave, survive

- `POST /v1/party` with CSPRNG codes over an unambiguous alphabet; per-IP rate limits.
- Join by code and by link; nickname entry; member list; presence.
- Reconnect with `resume`, epoch-delta catch-up, and identity preservation.
- Durable Object storage so a party survives eviction; expiry when empty.
- The full transport command set with the concurrency damping from
  [`PROTOCOL.md`](PROTOCOL.md) §6 — including idempotent `next`, which must exist before
  anyone tests with three people.
- The simulation harness in CI.

**Exit criterion:** four people join a party from four networks, all four can play/pause/seek,
concurrent commands never desync the room, and killing the Durable Object mid-party recovers
transparently.

---

## Phase 3 — The queue

The feature the whole thing exists for.

- `shadow` adapter first: WeListen owns the queue, drives the player track by track. This is
  the permanent fallback and must always work.
- Then the `native` or `playlist` adapter per the Phase 0 findings, behind a runtime
  capability probe with automatic degradation.
- Fractional index ordering; add, remove, move, jump-to.
- Server-side track advance via Durable Object alarms; quorum-based early advance.
- Search-and-add via InnerTube; "add to party" from YouTube Music's own context menus.

**Exit criterion:** the shared queue survives a hundred random concurrent mutations from four
clients with identical final ordering on every client, and adapter degradation is exercised by
a test that deliberately breaks the native path.

---

## Phase 4 — The UI people actually see

- Nav-bar entry point, party panel, player-bar badge, attribution toasts — all in shadow DOM,
  all themed from YouTube Music's CSS custom properties.
- SPA-resilient mounting; idempotent, keyed, debounced.
- Per-member sync status and stall states in the member list.
- Onboarding that states the ad limitation honestly on first run.
- Full keyboard navigation, real ARIA labels, visible focus rings, `prefers-reduced-motion`.
- Toolbar popup: status, quick join, settings.

**Exit criterion:** someone who has never seen the project installs it, starts a party, and
gets a second person listening — without being told how. Watch three people do it; fix what
they trip on.

---

## Phase 5 — Hardening

- All the failure modes in [`ARCHITECTURE.md`](ARCHITECTURE.md) §8, each with a test.
- Ad handling, `waitForAll` option, unplayable-track quorum skip.
- Background-tab throttling; multi-tab active-tab designation.
- Abuse: join rate limits, per-member command rate limits, nickname sanitisation, room size
  cap, queue length cap.
- Security review of the bridge, the protocol validators, and every `textContent` boundary.
- Error taxonomy: every failure produces a specific, honest, user-legible message. "WeListen
  needs an update" is a better outcome than a half-working extension.

**Exit criterion:** the full failure-mode table passes as automated tests, and a self-directed
security review of the bridge and protocol boundaries is written up and its findings closed.

---

## Phase 6 — Publish

- Chrome Web Store listing: screenshots, a demo video, and a privacy policy that is short
  because there is genuinely nothing to disclose.
- A permission justification for each requested permission, written before submitting.
- Prepare for review questions on the two things reviewers always ask about here: why
  `music.youtube.com` host access is needed, and confirmation that no remote code is executed.
- Versioned rollout, a staged percentage if available, and a rollback plan.
- Server: production Cloudflare deployment, custom domain, uptime and error alerting, and a
  cost model that confirms an idle party costs nothing.
- Protocol version N-1 compatibility window for slow-updating clients.

**Exit criterion:** listed, installable by anyone, with a documented rollback path and alerts
that fire before users notice.

---

## Deliberately out of scope for v1

Named here so they do not creep in: voice chat, text chat, Firefox and Safari builds, mobile,
persistent user accounts, saved parties and history, playlist import, party discovery, DJ
rotation, vote-to-skip, and support for anything other than YouTube Music. Several are good
ideas. None of them are the thing that has to work first.
