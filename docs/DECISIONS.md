# Decisions

Each entry records what was decided, what it was chosen over, and why — so that when one of
these turns out to be wrong, the reasoning is available to argue with instead of guess at.

---

## D1 — Backend: Cloudflare Workers + Durable Objects

**Status:** decided.

The question asked was specifically *"what is the best option for eventually publishing to the
Web Store for anyone to use without complex setup?"* — so the criterion here is not raw
performance, it is: an ordinary person installs the extension and it works, forever, without
us going bankrupt or waking up to an outage.

Every hosted option makes installation equally simple, because the backend URL is baked into
the extension either way. The end user never configures anything. So the differences are all
on our side of the line — and there they are large:

**Idle cost.** A listen-party product has a long tail of small rooms that sit idle. Durable
Objects' WebSocket Hibernation API evicts an idle room from memory while keeping its
connections alive, so a party with nobody talking costs approximately nothing. A Node process
on a VPS costs the same whether it is serving 500 rooms or zero. At the scale a new extension
actually sees, that difference is the entire hosting bill.

**One room, one object.** A Durable Object is a single-threaded, globally addressable,
consistent instance. Routing every member of party `ABC123` to the object named `ABC123` is
the whole of the sharding design. That single-threadedness is also what makes
[`PROTOCOL.md`](PROTOCOL.md) §6 tractable: with everyone holding equal control, we need a
total order on commands, and the Durable Object hands us one for free. On a multi-process Node
deployment we would be building that ordering ourselves with Redis, and getting it subtly
wrong.

**Latency where it matters.** The clock estimator's accuracy degrades with path asymmetry, so
being close to users measurably improves sync quality. Workers run at the edge.

**Review surface.** A single `wss://` origin in `host_permissions` is trivially justifiable in
Chrome Web Store review. No OAuth means no Google verification process at all — which removes
the longest and least predictable step from shipping.

**Operations.** No servers, no TLS renewal, no deploy pipeline to babysit, and a free tier
that comfortably covers early adoption.

Rejected:

- **Node + Fastify on a VPS** — the most debuggable option, and the one to fall back to if
  Durable Objects prove awkward. But we would own uptime, TLS, deploys, and we would have to
  build the command-ordering guarantees ourselves. Costs money at zero users.
- **Supabase / Firebase Realtime** — fastest to a demo, but generic pub-sub adds broadcast
  latency in the exact place where this product's quality lives, and gives us little control
  over the timing protocol. Wrong trade for a product that is *entirely* a timing protocol.
- **WebRTC peer-to-peer** — appealing on latency and cost, but needs TURN servers anyway
  (so, not actually free or setup-free), and a full mesh with authoritative shared state gets
  fragile past a handful of people. It also has no natural home for the authoritative clock,
  which would put us back to host-election and its failure modes.

**Revisit if:** Durable Object costs become non-trivial at scale, or a hard requirement for
self-hosting appears.

---

## D2 — No accounts; a party is a code and a nickname

**Status:** decided.

Six-character code, type a name, done. No sign-up, no OAuth consent screen, no PII, no
password reset flow, no privacy policy with anything in it. It removes the single largest
piece of infrastructure and the single largest source of store-review friction.

The protocol still carries a `memberId` and a resume `token`, so if persistent identity is
ever wanted, it drops in without a wire-format break.

**Cost accepted:** anyone with a code can join. Codes are therefore treated as capability
tokens — CSPRNG, unambiguous alphabet, rate-limited — and a party can be closed to new
joiners.

---

## D3 — Everyone has equal control

**Status:** decided.

Any member can play, pause, seek, skip, add, remove, reorder. There is no host.

This is the better model for the actual use case — friends listening together — and it is
also *architecturally simpler* than host-authority, which is counterintuitive enough to be
worth stating: with a host, you need host election, host migration when their laptop closes,
and a story for what the room does in between. With the server as the sole authority, all of
that disappears. Nobody's departure interrupts the music.

What it costs is conflict handling, which is real but bounded, and is handled in
[`PROTOCOL.md`](PROTOCOL.md) §6:

- The Durable Object's single thread gives a total order — there are no lost updates.
- Fractional index keys make concurrent inserts commute.
- Transport commands are debounced and rate-limited per member and per room, so a scrub-war
  produces one winner per window rather than a seizure.
- `next` carries the `itemId` the sender believed was playing, so three people pressing skip
  at once skips one song. This is the most common bug in this product category and it is
  designed out from the start rather than patched in later.
- Every action is attributed in the UI. Most conflicts are social, and attribution resolves
  them at the correct layer.

**Revisit if:** rooms routinely exceed ~8 people, where the aux-cord problem stops being
funny. The `setOption` command already exists as the place to add a stricter mode.

---

## D4 — TypeScript + Vite, native-looking injected UI

**Status:** decided.

TypeScript matters more than usual here because most of the risk is in loosely-typed,
undocumented data from YouTube Music internals. Types at the `inject/` boundary are how we
notice a shape change at build time rather than in a user's browser.

Vite over WXT for now: WXT would remove real boilerplate, but this project's needs are
unusual — a MAIN-world script at `document_start`, a nonce-authenticated bridge, a possible
offscreen document — and a thin config we fully control is easier to bend than a framework we
would be fighting. Revisit if the manifest and build config become a maintenance burden.

Native styling via YouTube Music's own CSS custom properties, rendered into shadow DOM. The
theme follows the app, including future redesigns, for free.

**Cost accepted:** brittleness against redesigns. Mitigated by keeping every selector in one
file, capability-probing at mount, and degrading honestly.

---

## D5 — The server is the authority; position is an anchor

**Status:** decided.

Clients send intent; the server sends truth. Position is never a moving number — it is
`{ positionMs, atServerMs, rate }`, and current position is derived. Pause is `rate: 0`.

An anchor cannot drift because it does not move. This single representational choice deletes
a whole category of bug that would otherwise be found one at a time over months.

---

## D6 — Three queue adapters, selected at runtime

**Status:** decided in shape, dependent on Phase 0 for which is primary.

The requirement is a queue synced *natively* — the user should see YouTube Music's own queue,
shared. But that requires writing to YouTube Music's internal store, which is the least
certain capability in the project.

So: build `shadow` (extension-owned queue) first as the permanent, always-works fallback,
then attempt `native` (store dispatch) or `playlist` (a real unlisted YouTube Music playlist as
the party queue) on top, chosen by a runtime capability probe. A user on a YouTube Music build
that breaks the native path gets a working extension with a less native queue, rather than a
broken one.

The active adapter is visible in the debug panel, so bug reports are diagnosable.

---

## D7 — The WebSocket lives in the service worker

**Status:** decided, with a pre-planned fallback.

One connection per browser, surviving SPA navigation and tab churn. The risk is MV3 service
worker termination; the 20s heartbeat counts as activity and should hold it open during an
active party. If the Phase 0 spike shows termination during quiet stretches, the connection
moves to an **offscreen document** — which is why `connection.ts` sits behind an interface.

Rejected: holding the socket in the content script. It avoids the lifetime problem but
introduces cross-tab leader election, which is more total complexity than the fallback.

---

## Open questions

**Q1 — Licence.** Not chosen. MIT or Apache-2.0 for adoption; a copyleft licence if
closed-source forks are a concern. Needs deciding before the repository goes public.

**Q2 — Terms of service.** WeListen plays no audio of its own: every participant streams from
their own YouTube Music session on their own account, exactly as if they had clicked play
themselves — the same shape as established watch-party extensions. That said, the extension
does automate interaction with the site and use its internal endpoints. Worth a considered
read of the YouTube Terms of Service before public launch, and worth deciding in advance how
to respond if Google objects. Not a blocker for building; is a blocker for promoting.

**Q3 — Ads.** Non-Premium listeners get ad breaks others do not, and no amount of engineering
fixes that. The default is that the party continues without them and they rejoin in sync.
This needs stating plainly in onboarding and in the store listing, because it is the most
likely source of disappointed reviews.

**Q4 — Room size cap.** Durable Objects will handle far more than the product should. The
real limit is social: equal control stops working somewhere around eight people. Start with a
soft cap and instrument it.

**Q5 — Do we need a landing page?** A join link has to land somewhere for people who do not
have the extension installed. Cheapest answer is a static page on the same Worker that detects
the extension and otherwise links to the store listing. Needed by Phase 6, not before.

**Q6 — Regional availability.** A track available to one member may be unavailable to another.
Quorum-skip handles the common case, but a room split across regions could thrash. Measure
before building anything more elaborate.
