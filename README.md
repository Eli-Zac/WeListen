# WeListen

A Chrome extension that turns [YouTube Music](https://music.youtube.com) into a shared
listening room. Install it, click **Listen Party** in the YouTube Music nav bar, share a
six-character code, and everyone who joins hears the same song at the same moment — with a
single shared queue that anyone in the room can add to, reorder, or skip.

WeListen does not stream, proxy, host, or re-encode any audio. Every participant plays the
track from their own YouTube Music session, on their own account. The extension only
synchronises *what* is playing, *where* in the track, and *what comes next*.

---

## Status

**Planning.** No code has been written yet. This repository currently contains the design
documents that the implementation will follow, and the tracked checklist below. Start here:

| Document | What it covers |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System shape, repo layout, how the extension reaches inside YouTube Music |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | The wire protocol: every message, both directions, with types |
| [`docs/SYNC.md`](docs/SYNC.md) | The clock-sync and drift-correction algorithm — the hard part |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phased milestones from spike to Chrome Web Store listing |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Decisions made, with reasoning, and the questions still open |
| [`docs/probe-findings.md`](docs/probe-findings.md) | Phase 0 spike answers — currently unverified, see the note at the top |

## Next steps

Ordered. Detail and exit criteria for every phase are in
[`docs/ROADMAP.md`](docs/ROADMAP.md); this is the tracking view.

### Blocked on a human, not on code

- [ ] Set `main` as the repository's default branch (Settings → Branches)
- [ ] Confirm a Cloudflare account is available, and **check the current plan requirements
      for Durable Objects** before committing to D1 — this is the one cost assumption in the
      whole design that has not been verified
- [ ] Form a position on the YouTube Terms of Service (Q2) — not a blocker for building,
      is a blocker for promoting
- [ ] Decide the room size cap to start with (Q4)

### Phase 0 — spike YouTube Music's internals

Throwaway code in `tools/probe/`. Findings land in `docs/probe-findings.md`.

- [x] Scaffold `tools/probe/` — bookmarklet + scratch extension, no build step
- [x] Write `docs/probe-findings.md` — **currently from public knowledge, not a live run**:
      this environment's network policy blocks `music.youtube.com` outright, so nothing here
      could actually reach the site. All seven questions below are answered provisionally with
      a stated confidence level; re-run the tooling in `tools/probe/` somewhere with real
      access and replace the doc before trusting any of it. `ARCHITECTURE.md` §4.2 is
      unchanged since Q3's write path came back genuinely unknown, not a definite no.
- [ ] *(needs a live run)* Confirm `#movie_player` exposes `seekTo` / `getCurrentTime` /
      `getPlayerState` / `getVideoData` / `loadVideoById`; measure `getCurrentTime()`
      resolution and jitter
- [ ] *(needs a live run)* **Does `setPlaybackRate()` honour 1.02, or snap to presets?**
      Decides whether the inaudible drift correction in [`docs/SYNC.md`](docs/SYNC.md) §3
      ships, or falls back to seek-only
- [ ] *(needs a live run)* **Can we `dispatch()` a queue mutation to `ytmusic-app.store` and
      have the UI honour it?** Decides whether the queue is truly native (D6) — capture the
      action type strings. Not a Phase 1 blocker; blocks Phase 3.
- [ ] *(needs a live run)* Read the queue from the store and `subscribe()` to changes
- [ ] *(needs a live run)* Measure seek cost: latency, re-buffer probability, overshoot
      distribution
- [ ] *(needs a live run)* Catalogue stable DOM mount anchors and their behaviour across SPA
      navigation → becomes `inject/selectors.ts`
- [ ] *(needs a live run)* Determine how ad breaks are detectable from the page, and what the
      player reports
- [ ] *(needs a live run)* Verify `ytcfg` is readable and an InnerTube search from page
      context succeeds

### Phase 1 — skeleton: two browsers, one song, no UI

- [ ] Monorepo, TypeScript, Vite, `packages/protocol` with zod schemas
- [ ] MV3 manifest, three-world scaffolding, nonce-authenticated MAIN ⇄ ISOLATED bridge
- [ ] Cloudflare Worker + `PartyRoom` Durable Object with WebSocket hibernation
- [ ] Clock offset estimator and the banded drift controller
- [ ] Debug overlay — **built now, not later**; it pays for itself within days
- [ ] Prove p95 drift < 150 ms across two machines for ten minutes, through a network drop

### Phase 2 — parties: create, join, leave, survive

- [ ] Party creation, CSPRNG codes, per-IP rate limits
- [ ] Join by code and link, nicknames, member list, presence
- [ ] Reconnect with `resume`, epoch-delta catch-up, identity preservation
- [ ] Durable Object storage so a party survives eviction; expiry when empty
- [ ] Full transport command set with concurrency damping, including idempotent `next`
- [ ] Simulation harness in CI

### Phase 3 — the queue

- [ ] `shadow` adapter first — the permanent fallback that must always work
- [ ] `native` or `playlist` adapter per the Phase 0 findings, behind a capability probe
- [ ] Fractional index ordering: add, remove, move, jump-to
- [ ] Server-side track advance via Durable Object alarms, with quorum early-advance
- [ ] Search-and-add via InnerTube; "add to party" in YouTube Music's own context menus

### Phase 4 — the UI people actually see

- [ ] Nav-bar entry point, party panel, player-bar badge, attribution toasts (shadow DOM)
- [ ] SPA-resilient mounting — idempotent, keyed, debounced
- [ ] Per-member sync and stall status in the member list
- [ ] Onboarding that states the ad limitation honestly on first run
- [ ] Keyboard navigation, ARIA labels, focus rings, `prefers-reduced-motion`
- [ ] Toolbar popup: status, quick join, settings

### Phase 5 — hardening

- [ ] A test for every failure mode in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §8
- [ ] Ad handling, `waitForAll` option, unplayable-track quorum skip
- [ ] Background-tab throttling; multi-tab active-tab designation
- [ ] Abuse limits: joins, commands, nickname sanitisation, room and queue caps
- [ ] Security review of the bridge, protocol validators, and `textContent` boundaries
- [ ] Error taxonomy — every failure produces an honest, specific message

### Phase 6 — publish

- [ ] Store listing: screenshots, demo video, privacy policy
- [ ] A one-sentence justification for every requested permission, written before submitting
- [ ] Production Cloudflare deploy, custom domain, uptime and error alerting, cost model
- [ ] Staged rollout with a documented rollback path
- [ ] Protocol N-1 compatibility window for slow-updating clients

## The shape of it in one picture

```
   Alice's Chrome                 Cloudflare edge                  Bob's Chrome
 ┌────────────────────┐                                        ┌────────────────────┐
 │ music.youtube.com  │                                        │ music.youtube.com  │
 │  ├ MAIN world      │        ┌──────────────────────┐        │  ├ MAIN world      │
 │  │  #movie_player  │        │  PartyRoom           │        │  │  #movie_player  │
 │  │  ytmusic-app    │        │  Durable Object      │        │  │  ytmusic-app    │
 │  ├ content script  │        │                      │        │  ├ content script  │
 │  │  injected UI    │        │  authoritative:      │        │  │  injected UI    │
 │  └ service worker ─┼───ws───┤   • queue (ordered)  ├───ws───┼─ service worker    │
 │                    │        │   • now playing      │        │                    │
 └────────────────────┘        │   • position anchor  │        └────────────────────┘
                               │   • members          │
        audio: direct from     └──────────────────────┘        audio: direct from
        Google to Alice                    ▲                   Google to Bob
                                           │
                              no audio ever passes through here
```

## Core design commitments

These are settled; the reasoning for each is in [`docs/DECISIONS.md`](docs/DECISIONS.md).

- **The server is the authority, not any client.** There is no "host" whose laptop closing
  ends the party. The Durable Object holds the truth and everyone reconciles toward it.
- **Everyone has equal control.** Any member can play, pause, seek, skip, add, remove, or
  reorder. Conflicts are resolved by the server's arrival order, not by rank.
- **No accounts.** A party is a six-character code and a nickname you type. No sign-up, no
  OAuth consent screen, no personal data stored.
- **Native-looking UI.** Controls are injected into YouTube Music's own nav bar, player bar,
  and queue panel, styled with YouTube Music's own CSS custom properties.
- **No remote code.** Everything the extension runs ships inside the package. This is both a
  Chrome Web Store hard requirement and a good idea.

## Licence

MIT — see [`LICENSE`](LICENSE).
