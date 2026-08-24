// Vite over a plugin like @crxjs/vite-plugin, deliberately (docs/DECISIONS.md
// D4): this project's needs — a MAIN-world script at document_start, a
// nonce-authenticated bridge, three independently-bundled entry points that
// MV3 forbids from sharing code-split chunks — are unusual enough that a
// plugin fights us more than it saves. This script calls Vite's build() API
// once per entry point instead of relying on Vite's normal multi-entry
// output, because Rollup's iife/umd formats (required for content scripts,
// which MV3 does not allow to be ES modules) do not support code-splitting
// across multiple entries.
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { manifest } from './manifest.config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'dist');

const wsUrl = process.env.WELISTEN_WS_URL ?? '';

/** @type {{ name: string, input: string, format: 'es' | 'iife' }[]} */
const entries = [
  { name: 'background', input: 'src/background/index.ts', format: 'es' },
  { name: 'content', input: 'src/content/index.ts', format: 'iife' },
  { name: 'inject', input: 'src/inject/index.ts', format: 'iife' },
];

rmSync(outDir, { recursive: true, force: true });

for (const entry of entries) {
  await build({
    root: here,
    configFile: false,
    define: {
      __WELISTEN_WS_URL__: JSON.stringify(wsUrl),
    },
    build: {
      outDir,
      emptyOutDir: false, // three sequential builds share outDir
      lib: {
        entry: resolve(here, entry.input),
        formats: [entry.format],
        fileName: () => `${entry.name}.js`,
        name: entry.name,
      },
      target: 'es2022',
      minify: false,
      sourcemap: true,
    },
    logLevel: 'warn',
  });
}

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`[welisten] built ${entries.map((e) => e.name).join(', ')} -> ${outDir}`);
