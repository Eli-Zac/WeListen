# Synchronisation

This is the part of WeListen that is actually difficult, and the part that determines whether
the product feels magical or broken. Everything else is plumbing.

## The target

| Threshold | Perceptual meaning |
| --- | --- |
| < 40 ms | Indistinguishable if both listeners are in the same room |
| < 150 ms | Comfortable for people on a voice call together |
| < 400 ms | Noticeably "off" but tolerable |
| > 400 ms | Broken |

**Goal: hold steady-state drift under 150 ms, and correct any excursion within two seconds.**
Sub-40ms across the open internet, through an audio pipeline we do not control, is not
achievable and should not be promised.

---

## 1. Estimating the offset to server time

Every client's `Date.now()` is wrong by an unknown amount — usually tens of milliseconds, but
a machine with a broken NTP setup can be minutes out. We never care about absolute time, only
about a stable mapping between local time and the Durable Object's clock.

The measurement is a cut-down NTP exchange:

```
t0 = client sends   ping { clientMs: t0 }
t1 = server receives, replies  pong { clientMs: t0, serverMs: t1 }
t2 = client receives

rtt    = t2 - t0
offset = t1 - (t0 + t2) / 2       // add to local time to get server time
```

This assumes the network is symmetric, which it is not, so a single sample is unreliable —
the error is roughly half the path asymmetry. Two mitigations, both cheap:

1. **Take the best sample, not the average.** Collect samples and keep the one with the
   lowest RTT; the lowest-RTT exchange is the one with the least queuing delay and therefore
   the least asymmetry. Averaging actively makes this worse by mixing in the bad samples.
2. **Keep a small rolling window** — eight samples — and use the minimum-RTT sample within
   it, refreshing every 20s alongside the keepalive. This tracks slow clock drift without
   reacting to one bad packet.

Seed with five rapid pings on connect. Do not join playback until the estimate has settled;
`stddev(offset) < 25ms` over the seed samples is a reasonable gate, with a 3s hard timeout
after which we proceed with a warning badge rather than blocking the user.

**Never use monotonic `performance.now()` for this.** It is immune to wall-clock jumps, which
sounds ideal, but its zero point differs per document and it drifts against real time under
throttling. Use `Date.now()` and re-estimate periodically. Do use `performance.now()` for
measuring the *duration* of local operations.

```ts
interface ClockEstimate {
  offsetMs: number       // serverMs ≈ Date.now() + offsetMs
  rttMs: number          // of the sample this estimate came from
  confidence: 'seeding' | 'good' | 'degraded'
  updatedAt: number
}
```

---

## 2. Where should I be right now?

Given the anchor from [`PROTOCOL.md`](PROTOCOL.md) §5 and the clock estimate:

```ts
function targetPositionMs(anchor: Anchor, clock: ClockEstimate): number {
  const nowServerMs = Date.now() + clock.offsetMs
  return anchor.positionMs + (nowServerMs - anchor.atServerMs) * anchor.rate
}
```

That is the whole of the theory. The rest is dealing with a player that does not obey.

---

## 3. The drift controller

Runs at 4 Hz on the active tab, in the ISOLATED world, driving the MAIN world adapter.

```ts
const drift = playerPositionMs - targetPositionMs(anchor, clock)   // + means we are ahead
```

Correction is banded, because the right response depends entirely on the magnitude:

| Drift | Action | Why |
| --- | --- | --- |
| `< 25 ms` | Nothing | Below the noise floor of `getCurrentTime()` itself. Correcting here means oscillating forever. |
| `25–250 ms` | **Rate nudge**: `setPlaybackRate(1 ∓ 0.02)` until inside the deadband, then back to 1.0 | Inaudible. 2% is well under the ~4% pitch-shift perception threshold for music, and closes 250 ms in about 12 seconds. |
| `250 ms – 2 s` | **Aggressive rate nudge**: up to ±5%, capped at 4 seconds of correction; hard-seek if not resolved | 5% is faintly audible on sustained notes but far less jarring than a seek. |
| `> 2 s` | **Hard seek** to target + a small lead, then verify | Nothing else closes this gap in reasonable time. |
| Wrong `videoId` | Load the correct track, then hard-seek | Not drift at all — a different problem wearing its clothes. |

### Why rate correction is the centrepiece

A seek in a streaming player is not free: it may re-buffer, it produces an audible gap, and
it frequently overshoots — so a seek-only controller in a room with mild jitter creates a
click every few seconds and a permanently annoyed user. Rate correction is continuous and
inaudible, so the common case (small, ever-present drift) is handled silently and seeks are
reserved for genuine discontinuities.

This depends on YouTube Music honouring fine-grained playback rates. **Verify in the Phase 0
spike.** If rates snap to a preset list (0.75, 1, 1.25…), fall back to a seek-only controller
with a much wider deadband — roughly 400 ms — accepting worse sync in exchange for not
clicking constantly. Choose the controller at runtime from the probe result.

### Seek verification

A seek is a request, not a guarantee. After issuing one, wait for the player to leave the
buffering state, then re-measure. If the position is still wrong after two attempts, mark the
client `degraded`, surface it in the member list, and back off to attempting a resync at track
boundaries only — where a correction is free.

### Damping

The controller is a proportional controller with a deadband, and it must not fight itself:

- Only one correction in flight at a time.
- After a hard seek, a 1.5 s refractory period before measuring again — the player's reported
  position immediately after a seek is not trustworthy.
- If corrections exceed roughly six per minute, stop correcting, mark the client `degraded`,
  and tell the user plainly. A client that cannot hold sync should say so rather than
  stuttering silently forever.

---

## 4. Starting together

Naively broadcasting "play now" makes everyone start at a different moment, because the
message reaches each client at a different time and each player has a different startup
latency.

Instead, **schedule in the future.** On `play`, the server writes an anchor whose
`atServerMs` is roughly 400 ms ahead of now. Each client:

1. Converts that to local time via its offset.
2. Calls `seekTo(position)` and `playVideo()`, then immediately `pauseVideo()` to force
   buffering at the right spot.
3. Waits until the scheduled local instant, then resumes.

Everyone starts within one animation frame of each other, and the 400 ms is invisible because
it is under the latency people already expect from pressing play.

The same trick applies to track changes: the next track's anchor is published slightly ahead
of the previous track's end, so clients pre-buffer and cut over together instead of each
noticing the end and reacting independently.

---

## 5. Advancing the queue

Track ends are **not** driven by whichever client notices first — that races, and in a room of
five people the fastest client's timing wins every time.

The Durable Object holds an alarm scheduled for the current track's expected end
(`anchor.positionMs + durationMs`, adjusted on seek). When it fires, the server advances the
queue and publishes the next anchor. Clients that reach the end early simply hold.

Client reports of `ended` are advisory: they can bring the alarm *forward* if a quorum agrees
(which catches a track whose real duration differs from its metadata), but a single client
cannot advance the room.

---

## 6. Ads, and the honest limit

A listener without Premium gets ad breaks that other listeners do not. There is no
synchronisation trick that fixes this, and any design that pretends otherwise is lying.

Default behaviour: **the party does not stop.** The affected client reports `stalled: 'ad'`,
the room shows them as in an ad, and when the ad finishes they hard-seek to the party position
— arriving late but in sync. A mixed room with "wait for everyone" enabled would spend its
evening waiting.

The `waitForAll` room option inverts this for rooms where everyone is Premium or the group
would rather wait together. It is off by default.

This must be stated plainly in the store listing and in the onboarding, because it is the
most likely source of one-star reviews from people who expected magic. WeListen does not and
cannot remove ads.

---

## 7. Making it observable

Sync bugs are unreproducible by nature — they depend on network conditions, timing, and a
player we do not control. Build the instrumentation before the feature, not after.

- **In the party panel:** every member's live drift in milliseconds, their stall state, and
  their RTT.
- **A debug overlay** (behind a setting) plotting drift over time, every correction with its
  type and magnitude, the clock estimate with confidence, and which queue adapter is active.
  This one panel will save more time than any other thing built in Phase 1.
- **A drift histogram** per session, so "is it better than last week" is a measurement rather
  than an opinion.
- **No telemetry off-device by default.** If diagnostics are ever collected, they are
  explicitly opt-in, per session, and contain no titles, nicknames, or IDs.

## 8. How this gets tested

Sync is the one part of this project where manual testing is close to worthless — you cannot
feel 80 ms, and you cannot reproduce a 400 ms excursion on demand.

- **Unit:** the offset estimator against recorded sample sets including asymmetric and
  hostile ones; the drift controller against synthetic drift traces; `reduce.ts` against a
  concurrent-command corpus.
- **Simulation:** run N virtual clients against a local Durable Object with injected latency,
  jitter, and packet loss, with a fake player that models buffering and seek overshoot. Assert
  p95 drift under 150 ms. This runs in CI on every commit and is the primary regression net.
- **End-to-end:** Playwright with two real Chromium profiles against real YouTube Music,
  asserting both players converge. Slow, flaky, and irreplaceable — it is the only test that
  touches the actual internals. Run nightly, not per-commit, and treat a failure as a signal
  that YouTube Music changed.
