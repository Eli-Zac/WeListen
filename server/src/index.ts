import { PHASE1_CODE } from './party.js';
import type { WorkerEnv as Env } from './env.js';

export { PartyRoom } from './party.js';

// Phase 1 routing only. `POST /v1/party` (creation with CSPRNG codes) and
// `GET /v1/party/:code` (existence probe) are Phase 2 — see
// docs/ARCHITECTURE.md §6 and docs/ROADMAP.md.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/v1\/party\/([A-Z0-9]+)\/ws$/.exec(url.pathname);

    if (!match) {
      return new Response('not found', { status: 404 });
    }

    const code = match[1];
    if (code !== PHASE1_CODE) {
      return new Response('not found: only the hardcoded Phase 1 party exists', { status: 404 });
    }

    const id = env.PARTY_ROOM.idFromName(code);
    const stub = env.PARTY_ROOM.get(id);
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
