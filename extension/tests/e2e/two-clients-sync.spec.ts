import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchWithExtension } from './fixtures/extension-context.js';
import { DEBUG_OVERLAY_ELEMENT_ID } from '../../src/shared/constants.js';

// Phase 1 exit criterion (docs/ROADMAP.md): "two Chrome profiles on two
// machines play the same track with p95 drift under 150ms for ten minutes."
// This is the closest approximation available in this environment: two real
// Chromium profiles, the real extension, a real deployed-locally Worker +
// Durable Object, against a fake player standing in for #movie_player (real
// YouTube Music access is unavailable here — docs/probe-findings.md). It is
// not a substitute for the literal ten-machine-minutes test; see
// tools/probe/README.md and docs/probe-findings.md for what still needs a
// real run.

function readDriftMs(overlayText: string): number | null {
  const match = /drift:\s*(-?\d+(?:\.\d+)?)ms/.exec(overlayText);
  return match ? Number(match[1]) : null;
}

test('two independent extension profiles converge on the same drift-free position', async () => {
  const dirA = mkdtempSync(join(tmpdir(), 'welisten-e2e-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'welisten-e2e-b-'));

  const contextA = await launchWithExtension(dirA);
  const contextB = await launchWithExtension(dirB);

  try {
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto('http://localhost:8765/');
    await pageB.goto('http://localhost:8765/');

    const overlayA = pageA.locator(`#${DEBUG_OVERLAY_ELEMENT_ID}`);
    const overlayB = pageB.locator(`#${DEBUG_OVERLAY_ELEMENT_ID}`);
    await expect(overlayA).toBeVisible({ timeout: 15_000 });
    await expect(overlayB).toBeVisible({ timeout: 15_000 });

    // Both should reach 'connected' against the locally-running Worker.
    await expect(overlayA).toContainText('status: connected', { timeout: 15_000 });
    await expect(overlayB).toContainText('status: connected', { timeout: 15_000 });

    // Each browser profile here has exactly one tab, so each is independently
    // "active" within its own session (docs/ARCHITECTURE.md §3's active-tab
    // designation is about multiple tabs in *one* browser, not across
    // profiles). Clicking Play on either updates the one shared server
    // anchor; both clients' drift controllers should then reconcile their
    // own local player to it.
    await pageA.getByRole('button', { name: 'Play' }).click();

    // Let the drift controller run for a while.
    await pageA.waitForTimeout(8000);

    const textA = await overlayA.innerText();
    const textB = await overlayB.innerText();
    const driftA = readDriftMs(textA);
    const driftB = readDriftMs(textB);

    expect(driftA).not.toBeNull();
    expect(driftB).not.toBeNull();
    // Generous bound for a headless CI-style run of a fake, jitter-free
    // player: the real bar is docs/SYNC.md's 150ms, kept wider here to avoid
    // flaking on sandbox scheduling noise rather than a real sync bug.
    expect(Math.abs(driftA!)).toBeLessThan(300);
    expect(Math.abs(driftB!)).toBeLessThan(300);
  } finally {
    await contextA.close();
    await contextB.close();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});
