import { PHASE1_CODE } from './phase1.js';

// Injected at build time — see vite build script (build.mjs) `define`. Falls
// back to a local `wrangler dev` server so `pnpm build` works with no env set.
declare const __WELISTEN_WS_URL__: string;

export const WS_URL: string =
  typeof __WELISTEN_WS_URL__ === 'string' && __WELISTEN_WS_URL__.length > 0
    ? __WELISTEN_WS_URL__
    : `ws://localhost:8787/v1/party/${PHASE1_CODE}/ws`;

export const CLIENT_VERSION = '0.1.0';

export const DEBUG_OVERLAY_ELEMENT_ID = 'welisten-debug-overlay';
