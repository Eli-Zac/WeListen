import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reduce, type Anchor, type PartyState } from '@welisten/protocol';
import { ClockEstimator } from '../background/clock.js';
import { DampingState, decideCorrection } from '../content/drift.js';
import { FakePlayer } from './fake-player.js';
import { makeRng, SimulatedNetwork } from './network.js';

// docs/SYNC.md §8: "Simulation: run N virtual clients against a local
// Durable Object with injected latency, jitter, and packet loss, with a fake
// player that models buffering and seek overshoot. Assert p95 drift under
// 150 ms. This runs in CI on every commit and is the primary regression net."
//
// The "local Durable Object" here is `reduce()` itself — the pure function
// that *is* the Durable Object's authoritative state machine (party.ts is
// just WebSocket plumbing around it, already covered by server/src/party.test.ts).
// Everything else — the real ClockEstimator, the real drift controller, a
// fake player, a lossy/jittery simulated network — runs against it directly,
// on vitest's fake timers, so 60 simulated seconds run in well under a
// second of real time.
//
// This validates the *design*: it runs with useRateNudge=true, the rate-nudge
// controller docs/SYNC.md §3 describes, not extension/src/content/index.ts's
// current runtime default of false (Phase 0 couldn't verify Q2 live — see
// docs/probe-findings.md). The seek-only fallback's wider ~400ms deadband is
// intentionally worse than the 150ms target; this test exists to prove the
// *rate-nudge* design meets that target once Q2 is confirmed.

function percentile(sortedAbs: number[], p: number): number {
  if (sortedAbs.length === 0) return 0;
  const idx = Math.min(sortedAbs.length - 1, Math.floor(p * sortedAbs.length));
  return sortedAbs[idx]!;
}

function initialState(): PartyState {
  return {
    code: 'SIM',
    epoch: 0,
    nowPlaying: { itemId: 'i1', videoId: 'sim-track', positionMs: 0, atServerMs: Date.now(), rate: 0 },
    queue: [],
    members: [],
    options: { waitForAll: false, allowClear: true },
  };
}

interface SimClient {
  clock: ClockEstimator;
  damping: DampingState;
  player: FakePlayer;
  network: SimulatedNetwork;
  driftSamplesAbs: number[];
  online: boolean; // toggled false to simulate a network drop
}

function makeClient(rng: () => number, network: SimulatedNetwork): SimClient {
  return {
    clock: new ClockEstimator(),
    damping: new DampingState(),
    player: new FakePlayer(() => Date.now(), {
      seekOvershootMs: () => (rng() * 2 - 1) * 60, // +-60ms
      seekBufferMs: () => 100 + rng() * 100, // 100-200ms
    }),
    network,
    driftSamplesAbs: [],
    online: true,
  };
}

function runSimulation(opts: {
  clientCount: number;
  durationMs: number;
  seed: number;
  network: { baseLatencyMs: number; jitterMs: number; lossRate: number };
  dropClientIndexAt?: { index: number; fromMs: number; toMs: number };
}) {
  const rng = makeRng(opts.seed);
  let serverState = initialState();

  const anchorNetwork = new SimulatedNetwork({ ...opts.network, lossRate: 0 }, rng); // TCP-reliable in reality
  const clients: SimClient[] = Array.from({ length: opts.clientCount }, () =>
    makeClient(rng, new SimulatedNetwork(opts.network, rng))
  );
  const latestAnchor: (Anchor | null)[] = clients.map(() => null);

  function broadcastAnchor(): void {
    const anchor = serverState.nowPlaying;
    clients.forEach((client, i) => {
      if (opts.dropClientIndexAt && i === opts.dropClientIndexAt.index && !client.online) return;
      anchorNetwork.send(anchor, (a) => {
        latestAnchor[i] = a;
      });
    });
  }

  function sendPing(client: SimClient): void {
    if (!client.online) return;
    const clientMs = Date.now();
    client.network.send({ clientMs }, (ping) => {
      const serverMs = Date.now();
      client.network.send({ clientMs: ping.clientMs, serverMs }, (pong) => {
        client.clock.recordSample(pong.clientMs, pong.serverMs, Date.now());
      });
    });
  }

  for (const client of clients) {
    for (let i = 0; i < 5; i++) setTimeout(() => sendPing(client), i * 50);
  }
  const pingInterval = setInterval(() => {
    for (const client of clients) sendPing(client);
  }, 20_000);

  setTimeout(() => {
    serverState = reduce(serverState, { k: 'play' }, { nowServerMs: Date.now(), memberId: 'sim' });
    broadcastAnchor();
  }, 1000);

  if (opts.dropClientIndexAt) {
    const { index, fromMs, toMs } = opts.dropClientIndexAt;
    setTimeout(() => {
      clients[index]!.online = false;
    }, fromMs);
    setTimeout(() => {
      clients[index]!.online = true;
      broadcastAnchor(); // reconnect: catch up on the current anchor
    }, toMs);
  }

  const driftInterval = setInterval(() => {
    clients.forEach((client, i) => {
      client.player.tick();
      if (!client.online) return;
      const anchor = latestAnchor[i];
      if (!anchor) return;

      const clockEstimate = client.clock.estimate(Date.now());
      if (clockEstimate.confidence === 'seeding') return;

      const shouldPlay = anchor.rate > 0;
      const playerState = client.player.getPlayerState();
      if (shouldPlay && playerState !== 1 && playerState !== 3) client.player.play();
      else if (!shouldPlay && playerState === 1) client.player.pause();

      const nowMs = Date.now();
      // docs/SYNC.md §3: skip measuring, not just correcting, during the
      // post-hard-seek refractory window — see content/index.ts's driftTick.
      if (!client.damping.canCorrect(nowMs)) return;

      const correction = decideCorrection(client.player.getCurrentTimeMs(), anchor, clockEstimate, client.player.videoId, true);
      if (Number.isFinite(correction.driftMs)) client.driftSamplesAbs.push(Math.abs(correction.driftMs));

      if (correction.type !== 'none') {
        client.damping.beginCorrection(correction.type, nowMs);
        if (correction.type === 'rateNudge' || correction.type === 'aggressiveRateNudge') {
          client.player.setPlaybackRate(correction.rate ?? 1);
        } else {
          client.player.seekTo(correction.seekToMs ?? 0);
          client.player.setPlaybackRate(1);
        }
        client.damping.endCorrection();
      } else if (correction.type === 'none' && client.player.getPlaybackRate() !== 1) {
        client.player.setPlaybackRate(1);
      }
    });
  }, 250);

  return { clients, stop: () => { clearInterval(pingInterval); clearInterval(driftInterval); } };
}

describe('sync simulation (docs/SYNC.md §8)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('holds p95 drift under 150ms across 4 clients under jittery, lossy network conditions', async () => {
    const durationMs = 600_000; // 10 minutes, matching docs/ROADMAP.md's Phase 1 exit criterion window
    const { clients, stop } = runSimulation({
      clientCount: 4,
      durationMs,
      seed: 42,
      network: { baseLatencyMs: 50, jitterMs: 30, lossRate: 0.05 },
    });

    await vi.advanceTimersByTimeAsync(durationMs);
    stop();

    for (const [i, client] of clients.entries()) {
      expect(client.driftSamplesAbs.length, `client ${i} got too few settled samples`).toBeGreaterThan(50);
      const sorted = [...client.driftSamplesAbs].sort((a, b) => a - b);
      const p95 = percentile(sorted, 0.95);
      expect(p95, `client ${i} p95 drift`).toBeLessThan(150);
    }
  });

  it('recovers within a bounded time after a client network drop and reconnect', async () => {
    const durationMs = 45_000;
    const { clients, stop } = runSimulation({
      clientCount: 3,
      durationMs,
      seed: 7,
      network: { baseLatencyMs: 40, jitterMs: 20, lossRate: 0.03 },
      dropClientIndexAt: { index: 1, fromMs: 15_000, toMs: 25_000 },
    });

    await vi.advanceTimersByTimeAsync(durationMs);
    stop();

    const dropped = clients[1]!;
    // Samples recorded in the last 10s (well after the 10s-earlier reconnect)
    // should be back inside the steady-state bound.
    const recent = dropped.driftSamplesAbs.slice(-20);
    expect(recent.length).toBeGreaterThan(0);
    const sorted = [...recent].sort((a, b) => a - b);
    expect(percentile(sorted, 0.95)).toBeLessThan(150);
  });
});
