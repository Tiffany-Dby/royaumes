# ADR-0011 - Published Events, Transactional Messaging and Private Realtime for Daily Quests

- Status: accepted
- Date: 2026-10-24

## Context

Daily Quests observes Village, Dungeon and Market activity and rewards the
player's Village. Completion events need earlier participation facts; private
notifications must isolate players. The platform supplies projections, an outbox
and SSE policies.

## Decision

- **Published contracts:** Quests imports gameplay modules only through
  `contracts.ts`, without private tables or module factories. The
  `quests-gameplay-contracts-only` rule and existing encapsulation rules enforce
  this boundary for runtime and type-only imports.

- **Gameplay integration:** The versioned `quests-progress` projection observes
  Village foundations and upgrades. Dungeon host/join events identify humans;
  `GameEnded` credits them for wins or losses, excluding companions. Market
  publication/acceptance events retain participants; payment refusal clears the
  buyer before another acceptance. `TradeCompleted` credits the seller and
  successful buyer: payment succeeded and deliveries were requested, not
  necessarily finished. Gameplay time and persistence/replay follow
  [ADR-0010](0010-daily-quests-persistence.md).

- **Reward protocol:** Acceptance commits `QuestRewardClaimAccepted` with one
  `REALM_TOPICS.deposit` message, using the reward snapshot and a deterministic,
  namespaced transfer ID. Village deduplicates that ID and atomically stores its
  deposit event and `replyTo` response to `quests.transfer-result`. Quests records
  `QuestRewardDelivered` only for a `deposited` confirmation matching an existing
  accepted claim and its exact canonical transfer ID. Repeated confirmations are
  ignored. `202 Accepted` acknowledges acceptance, not delivery; immediate
  dispatch is best effort. Pending status can outlast the actual deposit.

- **Delivery and consistency:** Possible redelivery requires idempotent consumers.
  Optimistic retries reload claim history; dispatch uses leases and bounded
  retries with the recovery limits in [ADR-0010](0010-daily-quests-persistence.md).
  Acceptance, Village delivery and confirmation are separate transactions, with
  no guaranteed delivery deadline.

- **Private invalidations:** Authenticated `/api/stream/quests` uses a source
  bound to the session for each connection. Relevant Village changes, Dungeon
  and Market completions, and accepted/delivered claims emit `QuestsChanged`
  with empty data and a neutral stream name. Original gameplay stream IDs and
  payloads are omitted; journal positions remain visible as resume IDs.
  The `/events` fallback uses the same authorization, filtering and sanitization,
  with private, non-cacheable responses. Filtering completion events requires
  published participant histories, independently of the progress projection.

- **Authoritative refresh:** The UI rereads `GET /api/quests` after invalidations,
  connection/reconnection, focus and UTC midnight, coalescing overlapping reads.
  Bounded retries of `503 QUESTS_NOT_READY` precede manual retry. SSE uses
  `Last-Event-ID` for resumption, not progress calculation or delivery proof.
  A transaction committed late behind its cursor can be missed: notifications
  are not lossless. GET refreshes the view subject to ADR-0010's projection limits.

## Consequences

### Positive

- Reuses the platform and keeps gameplay ownership inside existing modules.
- Accepted rewards survive dispatch failures.
- Private invalidations refresh authoritative data without client calculations
  or periodic client polling.

### Negative

- Eventual consistency can temporarily block reads or claims; retries are finite.
- Each SSE subscriber performs journal checks and completion-history reads.
  The connection-local cursor skips ignored events, but long reconnect gaps can
  require substantial replay.
- Participant attribution exists in projection and notification filtering;
  published-event changes must keep both aligned.

## Alternatives Rejected

- **Direct calls/database writes:** Couple modules and bypass ownership;
  synchronous deposits risk losing delivery between separate transactions.
- **Shared global notifications with payload redaction alone:** Retain original
  stream identifiers and reveal unrelated players' activity.
- **Dedicated notification storage or client polling:** Add state or repeated
  reads instead of reusing SSE sources and authoritative GET refresh.

## Reconsideration

Revisit if event contracts change, subscriber/replay costs become unacceptable,
or notification and delivery guarantees must exceed the platform's current limits.

## Generative AI Usage

- **Tools:** ChatGPT and Codex (OpenAI).
- **Contribution:** ChatGPT supported architectural discussion; Codex inspected
  communication, assisted implementation/tests and drafted this ADR. The project
  author reviewed decisions incrementally.
- **Verification:** Source review and local Vitest coverage of
  [claim/deposit/confirmation behavior](../../src/modules/quests/infrastructure/claim-persistence.test.ts),
  [API acceptance and delivery failures](../../src/bootstrap/quests-api.test.ts),
  [private SSE, fallback filtering and resumption](../../src/bootstrap/quests-realtime.test.ts),
  and [outbox retries and requeue](../../src/platform/outbox/outbox.test.ts).
  The [architecture rule](../../.dependency-cruiser.cjs) detected temporary
  prohibited runtime/type-only imports; the probes were removed afterwards.
  UI tests verify rendered markup, not browser interaction. Browser reconnection,
  production delivery and deployment have not been verified.
