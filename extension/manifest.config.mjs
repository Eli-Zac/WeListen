// Plain JS, not TS: this is read directly by build.mjs (a Node script, not
// bundled by Vite) with no loader step, keeping D4's "thin config we fully
// control" — see docs/DECISIONS.md D4.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));

// The Phase 1 e2e fixture (tests/e2e/fixtures/stub-player.html) stands in for
// music.youtube.com's #movie_player where real access is unavailable — see
// docs/probe-findings.md. Drop E2E_STUB_ORIGIN before Phase 6: every
// permission must be defensible in one sentence for Chrome Web Store review
// (docs/ARCHITECTURE.md §9).
const YTM_ORIGIN = 'https://music.youtube.com/*';
const E2E_STUB_ORIGIN = 'http://localhost:8765/*';

export const manifest = {
  manifest_version: 3,
  name: 'WeListen (dev)',
  description: 'Listen to YouTube Music together, in sync, with a shared queue.',
  version: pkg.version,
  background: {
    service_worker: 'background.js',
    type: 'module',
  },
  content_scripts: [
    {
      matches: [YTM_ORIGIN, E2E_STUB_ORIGIN],
      js: ['inject.js'],
      world: 'MAIN',
      run_at: 'document_start',
    },
    {
      matches: [YTM_ORIGIN, E2E_STUB_ORIGIN],
      js: ['content.js'],
      run_at: 'document_idle',
    },
  ],
  host_permissions: [YTM_ORIGIN, E2E_STUB_ORIGIN],
  permissions: ['storage'],
};
