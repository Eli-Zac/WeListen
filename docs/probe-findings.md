# Phase 0 probe findings

**Status: NOT empirically verified.** This does not meet the exit criterion in
[`ROADMAP.md`](ROADMAP.md) as written, which calls for a definite yes/no on Q2 and Q3 from a
live run. Read the reason before trusting anything below.

## Why this doc isn't the real thing

The environment this was written in has a network egress policy that returns `403` for
`music.youtube.com` — confirmed via the proxy's own status endpoint, not a flaky failure. No
code running there, headless or otherwise, authenticated or not, can reach the real site. That
rules out every option: a live headless run, driving the scratch extension, even a manual
`curl`.

Full tooling to do this properly exists and is committed — see [`../tools/probe/`](../tools/probe/):
a scratch MV3 extension, a bookmarklet, and a headless Playwright runner (`run-headless.mjs`),
all built around the same `probe.js` so a real run is one `chrome://extensions` load or one
`node tools/probe/run-headless.mjs` away, from anywhere that can reach the site. **Re-run it
and replace this document before Phase 3 begins** — Phase 3 is the phase that actually depends
on Q3's answer (see below).

What follows is what could be established without live access: publicly-known, common-knowledge
facts about how YouTube's web player and YouTube Music's Polymer app behave, of the kind that is
widely relied upon by existing open-source projects that already interact with these same
internals (desktop YouTube Music clients, playback-speed-controller extensions, ad-blocking
extensions, and unofficial YouTube Music API wrappers all depend on some subset of these APIs
existing and behaving as described). None of it was verified against a live `music.youtube.com`
session in this repository. Confidence is stated per answer; nothing here should gate a
decision the way a real Phase 0 pass would.

---

## Q1 — `#movie_player` API surface and `getCurrentTime()` resolution/jitter

**Confidence: high on API existence, no data on resolution/jitter.**

`document.querySelector('#movie_player')` exposing an imperative API — `playVideo`,
`pauseVideo`, `seekTo`, `getCurrentTime`, `getDuration`, `getPlayerState`, `getVideoData`,
`setPlaybackRate`, `getPlaybackRate` — is extremely well established for both `youtube.com` and
`music.youtube.com`, which share the same underlying player core. This is the same element and
API surface the public IFrame Player API mirrors, and it's what every existing playback-control
extension in this space already depends on.

**Not established:** actual resolution and jitter of `getCurrentTime()` under real network
conditions. `docs/SYNC.md` §1 assumes this needs measuring empirically — it still does. Assume
nothing better than "tens of milliseconds" until `run-headless.mjs` or the scratch extension has
actually run against the live site; the drift controller's `< 25ms` deadband in `SYNC.md` §3 is
the thing most sensitive to this number being wrong.

## Q2 — Does `setPlaybackRate()` honour fine-grained values, or snap to a preset list?

**Confidence: medium-high, leaning yes — but this is exactly the kind of answer Phase 0 exists
to make definite, and it isn't, yet.**

The settings-menu UI only exposes a preset list (0.25–2.0), but that's a UI constraint, not an
API constraint: YouTube's player wraps a standard HTML `<video>` element, and `setPlaybackRate`
on the underlying player is widely relied upon by existing playback-speed-controller extensions
to set arbitrary rates (1.02, 1.1, etc.), not just the presets. The prior is that
`SYNC.md` §3's rate-nudge controller (1 ∓ 0.02) will work as designed.

**What's actually missing:** a real measurement of whether YTM's specific build clamps or
rounds fine-grained values, and whether `getAvailablePlaybackRates()` (if present) reports
something narrower than what `setPlaybackRate` actually accepts. `probe.js`'s
`probePlaybackRate()` check is written and ready — it tries `[1.02, 0.98, 1.05, 0.95, 1.002]`
and reports which were honoured exactly. Until it runs for real, treat the rate-nudge
controller as unconfirmed and keep the seek-only fallback path (wider ~400ms deadband) live and
tested in Phase 1, not deleted.

## Q3 — `ytmusic-app.store`: readable, subscribable, and is a dispatched mutation honoured?

**Confidence: high that the store exists and is readable/subscribable. No confidence on the
write path — this is a genuine unknown, not a lean.**

YouTube Music is a Polymer application with a Redux-style store attached to the `ytmusic-app`
custom element, commonly referenced as `document.querySelector('ytmusic-app').store` with
`getState()` / `subscribe()` / `dispatch()`, and a queue reachable somewhere under
`state.queue`. This shape is consistent with how other projects that hook into YouTube Music's
internals describe it, and reading state this way is very likely to work.

**Genuinely open:** whether `dispatch()`-ing a queue mutation (add/remove/reorder) is honoured
by the UI, and what the action type strings even are — those are internal, minified/renamed
across deploys, and cannot be guessed reliably. `probe.js`'s `probeStore()` installs a
**non-destructive** `dispatch` wrapper that logs action types as the real UI dispatches them
(so a human tester clicking play/skip/reorder in their own session populates
`observedActions` without us mutating anything), plus a manual, deliberately-not-automated
`tryDispatchTest()` for a human to try once real action types are known, in a session where
breaking the queue doesn't matter.

**Consequence for the roadmap:** the exit criterion says to amend `ARCHITECTURE.md` §4.2 to
make the playlist-backed adapter primary *if* Q3's write path is a definite no. It isn't a
definite anything, so §4.2 is unchanged — `native` stays the preferred target, `playlist` the
strong fallback, `shadow` the permanent one. This doesn't block Phase 1, which hardcodes a
single track and touches no queue at all; it blocks Phase 3, which is where this must be
re-verified for real before committing engineering time to the `native` adapter.

## Q4 — Real cost of a seek: latency, re-buffer probability, overshoot distribution

**Confidence: none. No usable prior exists for this — it depends on YouTube's CDN, the
network path, and the specific build, none of which can be estimated from first principles.**

`probe.js`'s `probeSeekCost()` is written (3 trials of a 20s forward seek, timing time-to-playing
and measuring overshoot) but requires a track actually playing, which requires live access.
Treat this as completely unknown until it runs. `SYNC.md` §3's `250ms–2s` and `>2s` correction
bands are design choices, not measurements — they may need retuning once real numbers exist.

## Q5 — Stable DOM mount anchors across SPA navigation

**Confidence: medium.** Custom element tag names like `ytmusic-app`, `ytmusic-app-layout`,
`ytmusic-nav-bar`, `ytmusic-player-bar`, `ytmusic-player-queue`, and `tp-yt-app-drawer` are
consistent with publicly-documented Polymer component naming for this app and are a reasonable
starting point for `inject/selectors.ts`. What can't be established without live access is the
part that actually matters for Phase 0's purpose: *behaviour across SPA navigation* — whether
these nodes are destroyed and recreated on `yt-navigate-finish`, reused in place, or something
messier. `probe.js`'s `probeDomAnchors()` just snapshots presence; a real pass needs to run it
before and after navigating between a few different pages (search, a playlist, a queue) to see
what survives.

## Q6 — Ad detection from the page

**Confidence: low-medium.** Ad-related DOM markers (`.ad-showing`, `.ytp-ad-player-overlay`,
`.ytp-ad-text`) are shared with regular YouTube and reasonably well known from ad-blocking
extensions, but YouTube Music's ad experience for non-Premium listeners (audio ads specifically)
isn't necessarily identical to video-site ad breaks, and none of that public knowledge is
YTM-specific. `probe.js`'s `probeAds()` check exists but is only useful captured live, while an
ad is actually playing — genuinely unverified.

## Q7 — `ytcfg` readability and an InnerTube search from page context

**Confidence: high.** `window.ytcfg` exposing `INNERTUBE_API_KEY`, `INNERTUBE_CONTEXT`, and
related fields is very well established across YouTube properties, and an unauthenticated
`POST /youtubei/v1/search` using that key from page context is a widely-used pattern for public
search — it's expected to succeed even for a logged-out session, which matters because it means
search-and-add doesn't strictly require the user to be signed in beyond whatever session
YouTube Music already has. `probe.js`'s `probeInnertube()` check performs exactly this call and
records the real HTTP status; still needs a real run to confirm for the current API version.

---

## What to do with this

1. Nothing in Phase 1 depends on an unresolved answer above — Phase 1 hardcodes a single track
   and never touches the queue or search.
2. Before Phase 3 (`native`/`playlist` queue adapters) or before tuning `SYNC.md`'s correction
   bands off first real user reports, re-run this from `tools/probe/` somewhere that has real
   network access to `music.youtube.com`, and replace this document with actual measurements.
3. Q3 and Q4 are the ones that matter most and were the least establishable from general
   knowledge — prioritise those in the real run.
