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
documents that the implementation will follow. Start here:

| Document | What it covers |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System shape, repo layout, how the extension reaches inside YouTube Music |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | The wire protocol: every message, both directions, with types |
| [`docs/SYNC.md`](docs/SYNC.md) | The clock-sync and drift-correction algorithm — the hard part |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phased milestones from spike to Chrome Web Store listing |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Decisions made, with reasoning, and the questions still open |

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

Not yet chosen — see the open questions in [`docs/DECISIONS.md`](docs/DECISIONS.md).
