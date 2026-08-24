import type { ClockEstimate } from '../../background/clock.js';
import type { ConnectionStatus } from '../../background/connection.js';
import type { Correction } from '../drift.js';

// docs/SYNC.md §7: "A debug overlay (behind a setting) plotting drift over
// time, every correction with its type and magnitude, the clock estimate
// with confidence, and which queue adapter is active. This one panel will
// save more time than any other thing built in Phase 1." Built now, not
// later, per docs/ROADMAP.md Phase 1.

export interface DebugOverlayState {
  status: ConnectionStatus | 'idle';
  clock: ClockEstimate | null;
  lastCorrections: Correction[];
  driftHistory: { atMs: number; driftMs: number }[];
  active: boolean;
  degraded: boolean;
  queueAdapter: string;
}

export interface DebugOverlayHandle {
  render: (state: DebugOverlayState) => void;
}

function mkButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = 'font:11px monospace;padding:4px 8px;cursor:pointer;';
  b.addEventListener('click', onClick);
  return b;
}

function drawSparkline(canvas: HTMLCanvasElement, history: { atMs: number; driftMs: number }[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = '#333';
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  if (history.length < 2) return;
  const maxAbs = Math.max(150, ...history.map((h) => Math.abs(h.driftMs)));
  const t0 = history[0]!.atMs;
  const tN = history[history.length - 1]!.atMs;
  const span = Math.max(1, tN - t0);

  ctx.strokeStyle = '#0f0';
  ctx.beginPath();
  history.forEach((h, i) => {
    const x = ((h.atMs - t0) / span) * width;
    const y = height / 2 - (h.driftMs / maxAbs) * (height / 2 - 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // +-150ms reference band
  ctx.strokeStyle = 'rgba(255,255,0,0.3)';
  const bandY = height / 2 - (150 / maxAbs) * (height / 2 - 2);
  ctx.beginPath();
  ctx.moveTo(0, bandY);
  ctx.lineTo(width, bandY);
  ctx.moveTo(0, height - bandY);
  ctx.lineTo(width, height - bandY);
  ctx.stroke();
}

export function buildDebugOverlay(
  onManual: (action: 'play' | 'pause' | 'seek', valueMs?: number) => void
): { element: HTMLElement } & DebugOverlayHandle {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed',
    'bottom:12px',
    'right:12px',
    'z-index:2147483647',
    'width:340px',
    'background:#111',
    'color:#0f0',
    'font:11px/1.4 monospace',
    'padding:10px',
    'border-radius:8px',
    'box-shadow:0 4px 24px rgba(0,0,0,.5)',
  ].join(';');

  const pre = document.createElement('pre');
  pre.style.cssText = 'margin:0 0 6px 0;white-space:pre-wrap;';

  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 60;
  canvas.style.cssText = 'display:block;background:#000;margin-bottom:6px;width:100%;height:60px;';

  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:6px;';
  controls.append(
    mkButton('Play', () => onManual('play')),
    mkButton('Pause', () => onManual('pause')),
    mkButton('Seek +10s', () => onManual('seek', 10_000))
  );

  el.append(pre, canvas, controls);

  function render(state: DebugOverlayState): void {
    const lines: string[] = [];
    lines.push(`status: ${state.status}${state.active ? ' (active tab)' : ' (inactive tab)'}`);
    lines.push(
      `clock: ${state.clock ? `${state.clock.offsetMs.toFixed(1)}ms offset, ${state.clock.rttMs.toFixed(0)}ms rtt, ${state.clock.confidence}` : 'no estimate yet'}`
    );
    const last = state.driftHistory[state.driftHistory.length - 1];
    lines.push(`drift: ${last ? `${last.driftMs.toFixed(1)}ms` : 'n/a'}${state.degraded ? '  DEGRADED' : ''}`);
    lines.push(`queue adapter: ${state.queueAdapter}`);
    lines.push('recent corrections:');
    const recent = state.lastCorrections.slice(-5).reverse();
    if (recent.length === 0) lines.push('  (none)');
    for (const c of recent) {
      lines.push(`  ${c.type} drift=${Number.isFinite(c.driftMs) ? c.driftMs.toFixed(0) + 'ms' : '-'}`);
    }
    pre.textContent = lines.join('\n');
    drawSparkline(canvas, state.driftHistory);
  }

  return { element: el, render };
}
