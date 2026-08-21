// Runs probe.js against a real (unauthenticated) music.youtube.com session via
// Playwright, and writes the JSON report next to this file. No build step —
// run directly with `node tools/probe/run-headless.mjs`.
//
// This is this repo's own verification pass for Phase 0. It has no Google
// account, so anything gated behind sign-in comes back honestly incomplete
// rather than faked — see docs/probe-findings.md for what that leaves open.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const probeSource = readFileSync(join(here, 'probe.js'), 'utf8');

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    headless: true,
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  let navError = null;
  try {
    await page.goto('https://music.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000); // let the Polymer app boot
  } catch (err) {
    navError = String(err);
  }

  let report = null;
  let evalError = null;
  try {
    // page.evaluate runs in the page's main execution context — same JS heap
    // as inject/, exactly what probe.js needs.
    report = await page.evaluate(
      async (source) => {
        // eslint-disable-next-line no-eval
        (0, eval)(source);
        return await window.__weListenProbe.runAll();
      },
      probeSource
    );
  } catch (err) {
    evalError = String(err);
  }

  const out = {
    ranAt: new Date().toISOString(),
    navError,
    evalError,
    consoleErrors,
    report,
  };

  writeFileSync(join(here, 'headless-report.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
