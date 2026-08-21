import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// docs/SYNC.md §8: "End-to-end: ... Slow, flaky, and irreplaceable... Run
// nightly, not per-commit." This is that suite. It loads the real built
// extension against tests/e2e/fixtures/stub-player.html — a hand-rolled fake
// player, not real YouTube Music (unavailable in this environment; see
// docs/probe-findings.md) — so it exercises the real MV3 three-world
// architecture and the real deployed Worker, with a fake player standing in
// for #movie_player.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false, // multiple contexts share one extension's background service worker semantics
  webServer: [
    {
      command: `node -e "require('http').createServer((req,res)=>{const fs=require('fs');const path=require('path');let p=path.join(__dirname,'tests/e2e/fixtures',req.url==='/'?'/stub-player.html':req.url);fs.readFile(p,(err,data)=>{if(err){res.writeHead(404);res.end('not found');return;}res.writeHead(200,{'content-type':'text/html'});res.end(data);});}).listen(8765)"`,
      port: 8765,
      reuseExistingServer: false,
      timeout: 10_000,
    },
    {
      command: 'npx wrangler dev --port 8787 --local',
      cwd: resolve(here, '../server'),
      port: 8787,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  use: {
    trace: 'retain-on-failure',
  },
});
