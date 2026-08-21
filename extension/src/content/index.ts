import type { PartyState, PlayerState } from '@welisten/protocol';
import { call as bridgeCall } from './bridge.js';
import { keepMounted } from './mount.js';
import { buildDebugOverlay } from './ui/debug-overlay.js';
import { decideCorrection, DampingState, type Correction } from './drift.js';
import { PORT_NAME, type BackgroundToContent, type ContentToBackground } from '../shared/port-protocol.js';
import { DEBUG_OVERLAY_ELEMENT_ID } from '../shared/constants.js';
import type { ClockEstimate } from '../background/clock.js';
import type { ConnectionStatus } from '../background/connection.js';
import type { PlayerStateSnapshot } from '../shared/bridge-protocol.js';

// ISOLATED-world entry. Runs the 4Hz drift controller (docs/SYNC.md §3),
// reports progress to background at 1Hz, and renders the debug overlay
// (docs/SYNC.md §7). `useRateNudge` defaults false because Phase 0 could not
// verify Q2 live (docs/probe-findings.md) — flip once a real probe confirms
// setPlaybackRate() honours fine-grained values.
const USE_RATE_NUDGE = false;
const DRIFT_TICK_MS = 250; // 4Hz
const PROGRESS_TICK_MS = 1000;
const HISTORY_LIMIT = 200;

let latestState: PartyState | null = null;
let connectionStatus: ConnectionStatus | 'idle' = 'idle';
let latestClock: ClockEstimate | null = null;
let isActive = false;

const driftHistory: { atMs: number; driftMs: number }[] = [];
const lastCorrections: Correction[] = [];
const damping = new DampingState();

const port = chrome.runtime.connect({ name: PORT_NAME });

const overlay = buildDebugOverlay((action, valueMs) => {
  if (!isActive) return;
  if (action === 'play') post({ t: 'cmd', c: { k: 'play' } });
  else if (action === 'pause') post({ t: 'cmd', c: { k: 'pause' } });
  else if (action === 'seek') {
    void bridgeCall<PlayerStateSnapshot>('getPlayerState').then((snap) => {
      const currentMs = snap.currentTimeMs ?? 0;
      post({ t: 'cmd', c: { k: 'seek', positionMs: Math.max(0, currentMs + (valueMs ?? 0)) } });
    });
  }
});

keepMounted(DEBUG_OVERLAY_ELEMENT_ID, () => overlay.element);

function post(msg: ContentToBackground): void {
  port.postMessage(msg);
}

function renderOverlay(): void {
  overlay.render({
    status: connectionStatus,
    clock: latestClock,
    lastCorrections,
    driftHistory,
    active: isActive,
    degraded: damping.degraded,
    queueAdapter: 'n/a (Phase 1: no queue)',
  });
}

port.onMessage.addListener((msg: BackgroundToContent) => {
  switch (msg.t) {
    case 'status':
      connectionStatus = msg.status;
      break;
    case 'welcome':
      latestState = msg.state;
      break;
    case 'patch':
      // See background/session.ts's onStatePatch for why this cast is safe.
      if (latestState) latestState = { ...latestState, ...msg.patch } as PartyState;
      break;
    case 'clock':
      latestClock = msg.clock;
      break;
    case 'active':
      isActive = msg.active;
      break;
    case 'notice':
      console.warn('[WeListen] notice:', msg.code, msg.message);
      break;
  }
  renderOverlay();
});

setInterval(() => {
  void driftTick();
}, DRIFT_TICK_MS);

async function driftTick(): Promise<void> {
  if (!isActive || !latestState?.nowPlaying || !latestClock) return;

  let snap: PlayerStateSnapshot;
  try {
    snap = await bridgeCall<PlayerStateSnapshot>('getPlayerState');
  } catch {
    return;
  }
  if (!snap.present || snap.currentTimeMs === null) return;

  // Reconcile play/pause *state* independently of position drift: the drift
  // controller (docs/SYNC.md §3) only corrects position, and implicitly
  // assumes every client already started playing. Nothing else in Phase 1
  // does that for a client that never got a local play click — a real
  // gap this e2e suite caught (see the note above two-clients-sync.spec.ts).
  const shouldPlay = latestState.nowPlaying.rate > 0;
  if (shouldPlay && snap.playerState !== 1 && snap.playerState !== 3) {
    await bridgeCall('play').catch(() => {});
  } else if (!shouldPlay && snap.playerState === 1) {
    await bridgeCall('pause').catch(() => {});
  }

  const nowMs = Date.now();

  // docs/SYNC.md §3: "the player's reported position immediately after a
  // seek is not trustworthy" — damping's refractory window (hard seeks only)
  // exists precisely to mark that period, so skip *measuring* drift during
  // it too, not just skip issuing a new correction. Recording it anyway
  // pollutes the drift history with a spurious spike every hard seek (a real
  // gap the simulation harness caught — extension/src/simulation).
  if (!damping.canCorrect(nowMs)) {
    renderOverlay();
    return;
  }

  const correction = decideCorrection(
    snap.currentTimeMs,
    latestState.nowPlaying,
    latestClock,
    snap.videoId,
    USE_RATE_NUDGE
  );

  driftHistory.push({ atMs: nowMs, driftMs: Number.isFinite(correction.driftMs) ? correction.driftMs : 0 });
  if (driftHistory.length > HISTORY_LIMIT) driftHistory.shift();

  if (correction.type !== 'none') {
    damping.beginCorrection(correction.type, nowMs);
    lastCorrections.push(correction);
    if (lastCorrections.length > 50) lastCorrections.shift();
    try {
      if (correction.type === 'rateNudge' || correction.type === 'aggressiveRateNudge') {
        await bridgeCall('setPlaybackRate', { rate: correction.rate });
      } else {
        // hardSeek or wrongTrack
        await bridgeCall('seekTo', { positionMs: correction.seekToMs });
        await bridgeCall('setPlaybackRate', { rate: 1 });
      }
    } finally {
      damping.endCorrection();
    }
  } else if (snap.playbackRate !== null && snap.playbackRate !== 1) {
    // Back inside the deadband: restore normal speed after a rate-nudge.
    await bridgeCall('setPlaybackRate', { rate: 1 }).catch(() => {});
  }

  renderOverlay();
}

setInterval(() => {
  void progressTick();
}, PROGRESS_TICK_MS);

async function progressTick(): Promise<void> {
  if (!isActive) return;
  let snap: PlayerStateSnapshot;
  try {
    snap = await bridgeCall<PlayerStateSnapshot>('getPlayerState');
  } catch {
    return;
  }
  if (!snap.present || snap.currentTimeMs === null || snap.playerState === null) return;
  post({ t: 'progress', positionMs: snap.currentTimeMs, playerState: snap.playerState as PlayerState });
}
