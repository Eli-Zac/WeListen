# Phase 0 probe

Throwaway diagnostic tooling. Answers the seven questions in
[`../../docs/ROADMAP.md`](../../docs/ROADMAP.md) "Phase 0" by inspecting `music.youtube.com`'s
live internals: the `#movie_player` API, `ytmusic-app.store`, stable DOM anchors, ad detection,
and `ytcfg`/InnerTube. Findings land in [`../../docs/probe-findings.md`](../../docs/probe-findings.md).
None of this ships — see [`../../docs/DECISIONS.md`](../../docs/DECISIONS.md) D4 on why
everything YouTube Music-specific in the real product lives behind `extension/src/inject/`.

## Three ways to run it

### 1. Scratch extension (recommended — most complete, easiest to iterate on)

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select `tools/probe/extension/`.
2. Open `https://music.youtube.com`, play something (some checks — seek cost, ad detection —
   only produce data while a track is actually playing).
3. A small panel appears bottom-right after ~1.5s with a live summary. **Re-run probe** repeats
   it; **Copy JSON** copies the full report to your clipboard — paste that into
   `docs/probe-findings.md`.
4. To watch which Redux-style action types the app itself dispatches (for Q3), open DevTools →
   Console and interact with the UI (play/pause/skip/reorder). `probe.js` wraps
   `store.dispatch` non-destructively to observe, not to mutate — see `observedActions` in the
   JSON.
5. To test whether a *dispatched* queue mutation is honoured (the actual open question in Q3),
   run `window.__weListenProbe.tryDispatchTest(type, payload)` **manually** in DevTools, using an
   action type you found in step 4, and only in a session where messing up the queue doesn't
   matter. This is deliberately not automated — it is destructive to a real session.

### 2. Bookmarklet (quick, read-only-ish, no install)

Create a bookmark, paste the single line in [`bookmarklet.js`](bookmarklet.js) as its URL, and
click it on `music.youtube.com`. Prints a smaller summary to the console (and tries to copy it).
Good for a 10-second sanity check; the extension is the authoritative run.

### 3. Headless (this repo's own verification pass)

```
node tools/probe/run-headless.mjs
```

Drives `probe.js` inside a real Chromium via Playwright, **unauthenticated** (no Google
account). This repo does not have credentials for a real session, so anything that requires
being signed in (playback that requires Premium, personalised state) will come back
`testable: false` rather than a real answer — see `docs/probe-findings.md` for exactly what
that leaves unverified. Output is written to `tools/probe/headless-report.json` (gitignored)
and printed to stdout.

## Files

| File | World | Purpose |
| --- | --- | --- |
| `probe.js` | MAIN | The actual checks. Canonical copy — `extension/probe.js` is a manual sync of it (MV3 content scripts can't reference files outside their extension directory). |
| `extension/` | MV3 | Loads `probe.js` in MAIN world, publishes the report across the world boundary via a hidden DOM element, and renders a panel in ISOLATED world. |
| `bookmarklet.js` | MAIN (via `javascript:` URL) | Hand-written, deliberately independent of `probe.js` — condensed subset for a no-install quick check. |
| `run-headless.mjs` | Playwright `page.evaluate` (= MAIN world) | Runs the canonical `probe.js` without a browser UI, for a repeatable, committable pass. |
