// Every DOM selector and internal API name the project depends on lives here,
// and only here — see docs/ARCHITECTURE.md §1 "isolate the brittleness".
// Values are provisional pending a real Phase 0 run against a live
// music.youtube.com session; see docs/probe-findings.md.

export const PLAYER_SELECTOR = '#movie_player';

// Catalogued in probe.js's probeDomAnchors() for the real run; listed here as
// the current best guess for inject/content mounting.
export const DOM_ANCHORS = {
  app: 'ytmusic-app',
  appLayout: 'ytmusic-app-layout',
  navBar: 'ytmusic-nav-bar',
  playerBar: 'ytmusic-player-bar',
  player: PLAYER_SELECTOR,
} as const;
