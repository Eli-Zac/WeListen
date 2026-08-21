import { PLAYER_SELECTOR } from './selectors.js';
import type { PlayerStateSnapshot } from '../shared/bridge-protocol.js';

// The #movie_player adapter — docs/ARCHITECTURE.md §4.1. This is the only
// file allowed to call methods on the player element. Everything here is
// feature-detected: assume the shape can change on any YouTube Music deploy.
//
// The Phase 1 e2e fixture (tests/e2e/fixtures/stub-player.html) exposes a
// #movie_player with the same method names backed by a real <video>, so this
// adapter runs unmodified against both it and (eventually) the real site.

export interface YtmPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getVideoData(): { video_id: string; title?: string; author?: string };
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
}

function getElement(): (YtmPlayer & Element) | null {
  return document.querySelector(PLAYER_SELECTOR) as (YtmPlayer & Element) | null;
}

function hasFn<K extends string>(obj: object, key: K): obj is Record<K, (...args: never[]) => unknown> {
  return typeof (obj as Record<string, unknown>)[key] === 'function';
}

export function isAvailable(): boolean {
  const el = getElement();
  return !!el && hasFn(el, 'getCurrentTime') && hasFn(el, 'seekTo');
}

export function getSnapshot(): PlayerStateSnapshot {
  const el = getElement();
  if (!el) {
    return { present: false, currentTimeMs: null, playerState: null, videoId: null, playbackRate: null };
  }
  let currentTimeMs: number | null = null;
  let playerState: number | null = null;
  let videoId: string | null = null;
  let playbackRate: number | null = null;
  try {
    if (hasFn(el, 'getCurrentTime')) currentTimeMs = Math.round(el.getCurrentTime() * 1000);
  } catch {
    /* feature-detected but still fallible against a moving target */
  }
  try {
    if (hasFn(el, 'getPlayerState')) playerState = el.getPlayerState();
  } catch {
    /* ignore */
  }
  try {
    if (hasFn(el, 'getVideoData')) videoId = el.getVideoData()?.video_id ?? null;
  } catch {
    /* ignore */
  }
  try {
    if (hasFn(el, 'getPlaybackRate')) playbackRate = el.getPlaybackRate();
  } catch {
    /* ignore */
  }
  return { present: true, currentTimeMs, playerState, videoId, playbackRate };
}

export function play(): void {
  const el = getElement();
  if (el && hasFn(el, 'playVideo')) el.playVideo();
}

export function pause(): void {
  const el = getElement();
  if (el && hasFn(el, 'pauseVideo')) el.pauseVideo();
}

export function seekTo(positionMs: number): void {
  const el = getElement();
  if (el && hasFn(el, 'seekTo')) el.seekTo(positionMs / 1000, true);
}

export function setPlaybackRate(rate: number): void {
  const el = getElement();
  if (el && hasFn(el, 'setPlaybackRate')) el.setPlaybackRate(rate);
}
