# ADR-0010 - Event Sourcing and CQRS for Daily Quests

- Status: accepted
- Date: 2026-10-21

## Context

Daily Quests derives progress from Village, Dungeon and Market activity.
Progress resets at 00:00 UTC, while accepted reward claims must remain durable
and must never credit the same reward twice.

The platform provides optimistic concurrency, versioned projections and a
transactional outbox. Replaying gameplay must not grant rewards again.

## Decision

Use Event Sourcing for reward claims and settlement, and a versioned CQRS read
model for gameplay progress. Cross-module communication is specified in
[ADR-0011](0011-daily-quests-communication.md).

- **Time and identity:** A quest instance combines its UTC date and quest ID;
  player identity comes from authentication. Gameplay uses `data.at`, not
  `occurredAt`. Selecting the current UTC day resets visible progress without a
  scheduled task; replay retains historical days.

- **Owned read model:** The `quests` schema stores capped daily progress,
  temporary participation, and Village existence derived from `VillageFounded`.
  Participation survives midnight and is removed at activity termination. Village
  history currently survives identity deletion. Domain decisions remain pure;
  adapters retain database operations.

- **Authoritative claim history:** `QuestRewardClaimAccepted` and
  `QuestRewardDelivered` are stored in the platform journal. Reward status is
  computed from these events and projected eligibility, not stored in another
  projection. Accepted history overrides eligibility; pending means no recorded
  delivery confirmation.

- **Projection consistency:** Progress, supporting context and the checkpoint
  advance atomically through the versioned projection runner. Daily reads and
  new claim acceptance require catch-up through a captured journal position;
  an incomplete catch-up returns `503 QUESTS_NOT_READY`. The platform's gap-grace
  heuristic is not a strict cross-module snapshot: a commit arriving behind an
  advanced checkpoint may require reconstruction. Replay changes derived data,
  never claim history or deposit messages.

- **Durable claims:** Each player, UTC day and quest has one claim stream,
  protected by optimistic concurrency and authoritative history. The displayed
  day prevents a stale view from claiming a new day's quest. Completion, Village
  existence and expiration are checked at the final server-clock decision,
  including retries, even if the request began before midnight. Acceptance
  snapshots the reward resource/amount and a deterministic, namespaced transfer
  ID, committing atomically with its deposit request. Accepted rewards remain
  owed after midnight; delivery confirmation is a separate durable event.

- **Recovery:** Quest reads, accepted or duplicate claim requests, and the shared
  daily task trigger dispatch. Bounded retries process eligible messages on later
  dispatch calls, not through a continuous worker. Exhausted messages remain for
  operator requeue after fixing the cause; requeue itself does not dispatch.
  Failure neither erases acceptance nor proves that no deposit occurred.

- **Privacy:** The contributor exports the player's progress, participation,
  eligibility and claim history, omitting names and counterparty identifiers.
  Under [ADR-0008](0008-donnees-personnelles.md), name-free replay data and accepted
  obligations survive identity deletion, without a Quests erasure hook or
  scheduled expiry. This is pseudonymous retention, not physical deletion or
  complete anonymization.

## Consequences

### Positive

- Derived data can be rebuilt without granting rewards again.
- Durable claims and stable transfer IDs support idempotent acceptance/delivery.
- Storage and recovery reuse existing platform mechanisms.
- Daily resets require no background task.

### Negative

- Participant context and separate read/write models increase complexity.
- Projection lag can block an eligible claim, including near midnight.
- Delivery has no guaranteed completion deadline; dead letters require attention.
- Pseudonymous history remains after deletion; it is not fully anonymous.

## Alternatives Rejected

- **Conventional claim tables:** Viable with uniqueness and transactional messaging,
  but would require a separate atomic table-and-outbox persistence path. Claim
  events reuse the existing Event Store and support settlement reconstruction.
- **Event Sourcing for all progress:** Adds derived progress events when source
  gameplay events already provide the necessary history.
- **Scheduled reset:** Adds scheduling and recovery concerns without improving
  UTC date-based eligibility.

## Reconsideration

Reconsider if projection lag or reconstruction cost becomes unacceptable,
Village lifecycle rules change, delivery requires stronger recovery guarantees,
or pseudonymous retention no longer meets the project's privacy requirements.

## Generative AI Usage

- **Tools:** ChatGPT and Codex (OpenAI).
- **Contribution:** ChatGPT supported architectural discussion; Codex assisted
  implementation, tests and ADR revision. The project author reviewed decisions
  incrementally.
- **Verification:** Source review and local Vitest coverage of
  [domain decisions](../../src/modules/quests/domain/claim.test.ts),
  [projection replay and rollback](../../src/modules/quests/infrastructure/progress-projection.test.ts),
  [claim atomicity, concurrency and midnight handling](../../src/modules/quests/infrastructure/claim-persistence.test.ts),
  and [export, deletion and reconstruction](../../src/bootstrap/quests-privacy.test.ts).
  Browser behavior, production deployment/migrations and production delivery
  availability remain unverified.
