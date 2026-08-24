// A fake player that models buffering and seek overshoot, per docs/SYNC.md
// §8's simulation tier. Same state machine as
// tests/e2e/fixtures/stub-player.html's hand-rolled #movie_player, but a
// plain object (no DOM) so it can run inside a fast, fake-timer-driven
// vitest simulation rather than a real browser.
export interface FakePlayerConfig {
  seekOvershootMs: () => number; // signed: positive = lands past the target
  seekBufferMs: () => number;
}

export class FakePlayer {
  videoId = 'sim-track';
  private state: 1 | 2 | 3 = 2; // playing | paused | buffering
  private anchorMediaMs = 0;
  private anchorAtMs: number;
  private rate = 1;
  private bufferingUntilMs = 0;
  private pendingResumeState: 1 | 2 = 2;

  constructor(
    private nowMs: () => number,
    private config: FakePlayerConfig
  ) {
    this.anchorAtMs = nowMs();
  }

  private currentMediaMs(): number {
    if (this.state !== 1) return this.anchorMediaMs;
    return this.anchorMediaMs + (this.nowMs() - this.anchorAtMs) * this.rate;
  }

  private reanchor(): void {
    this.anchorMediaMs = this.currentMediaMs();
    this.anchorAtMs = this.nowMs();
  }

  /** Advances any pending buffering -> playing/paused transition. Call once per tick. */
  tick(): void {
    if (this.state === 3 && this.nowMs() >= this.bufferingUntilMs) {
      this.state = this.pendingResumeState;
      this.anchorAtMs = this.nowMs();
    }
  }

  play(): void {
    if (this.state === 3) return;
    this.reanchor();
    this.state = 1;
  }

  pause(): void {
    this.reanchor();
    this.state = 2;
  }

  seekTo(targetMs: number): void {
    const wasPlaying = this.state === 1;
    const overshoot = this.config.seekOvershootMs();
    this.anchorMediaMs = Math.max(0, targetMs + overshoot);
    this.anchorAtMs = this.nowMs();
    this.bufferingUntilMs = this.nowMs() + this.config.seekBufferMs();
    this.pendingResumeState = wasPlaying ? 1 : 2;
    this.state = 3;
  }

  setPlaybackRate(rate: number): void {
    this.reanchor();
    this.rate = rate;
  }

  getPlaybackRate(): number {
    return this.rate;
  }

  getPlayerState(): 1 | 2 | 3 {
    return this.state;
  }

  getCurrentTimeMs(): number {
    return this.currentMediaMs();
  }
}
