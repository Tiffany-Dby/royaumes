# ADR-0010 - Event Sourcing and CQRS for Daily Quests

- Status: proposed
- Date: 2026-10-21

## Context

Daily Quests derives progress from Village, Dungeon and Market activity.
Progress resets at 00:00 UTC, while accepted reward claims must remain durable
and must never credit the same reward twice.

The platform already provides an Event Store with optimistic concurrency,
versioned projections and a transactional outbox. Published gameplay events
sometimes require earlier events to identify their participants.

## Decision

The module combines Event Sourcing for reward claims and settlement with a
CQRS read model in the `quests` schema, reusing existing platform mechanisms.

- **Time and identity:** Gameplay eligibility uses the source event's `data.at`,
  not its database recording time (`occurredAt`). A daily quest instance is
  identified by its UTC date and quest identifier. Player identity comes from
  authentication. Selecting the current day resets the visible progress without
  a scheduled task; historical events retain their original day during replay.

- **Progress and participants:** The projection consumes `BuildingUpgraded`,
  `GameEnded` and `TradeCompleted`, together with the earlier published events
  needed to identify participants. Dungeon participation excludes companions;
  Market progress credits the seller and successful buyer. Supporting context
  survives day boundaries. `TradeCompleted` has its existing Market meaning:
  payment succeeded and deliveries were requested, not necessarily completed.

- **Village eligibility:** Village existence is derived from `VillageFounded`
  in the Quests projection. This relies on the current lifecycle, which retains
  Village history after account deletion. Quests reads no other module's tables
  or internal services.

- **Projection consistency:** Progress, supporting context and the checkpoint
  advance atomically through the versioned projection runner. Before a new claim,
  Quests requires catch-up through a captured journal position; otherwise, the
  request receives a retryable result. This preserves the platform's eventual
  consistency and position-gap limitations rather than providing a strict
  cross-module snapshot.

- **Durable claims:** Each player, UTC day and quest has one claim stream,
  protected by optimistic concurrency. Completion, Village existence and
  expiration are checked before acceptance, including on retries. A claim must
  still be eligible at the moment of the final claim decision, according to the
  server clock, even if the HTTP request started before midnight. The accepted
  event records the reward and a deterministic, namespaced transfer identifier;
  authoritative claim history prevents duplicate acceptance independently of
  the read model.

- **Delivery and settlement:** The accepted claim and its `REALM_TOPICS.deposit`
  request are persisted atomically. Village deduplicates by transfer identifier
  and confirms through the existing `replyTo` contract. Quests records confirmation
  idempotently and distinguishes pending from delivered rewards. Accepted claims
  remain deliverable after midnight. Projection replay never sends deposits.

- **Recovery:** Quests attempts outbox dispatch after claims and during reads,
  reusing the daily task and dead-letter tooling. Delivery failures leave claims
  durable and pending; exhausted retries require operator intervention.

- **Privacy:** A personal-data contributor exports progress and claim history.
  Quests stores player references without copying names. Account deletion follows
  ADR-0008: replay-essential references remain pseudonymous after identity removal.
  Erasure and reconstruction must produce equivalent data, while preserving
  transfer deduplication and settlement of accepted claims.

## Consequences

### Positive

- Progress and reward status can be reconstructed without granting rewards again.
- Concurrent requests and repeated deliveries cannot duplicate a reward.
- Integration reuses published events, Village contracts and platform mechanisms.
- Daily resets require no background task.

### Negative

- Participant context and separate read and write models increase complexity.
- Projection lag can temporarily delay an otherwise eligible claim, including
  near midnight.
- Delivery has no guaranteed completion deadline; dead letters require attention.
- Pseudonymous history remains after deletion; it is not fully anonymous.

## Alternatives Rejected

- **Conventional claim tables:** Viable with uniqueness and transactional messaging,
  but would require a separate atomic table-and-outbox persistence path. Claim
  events reuse the existing Event Store and support settlement reconstruction.
- **Event Sourcing for all progress:** Adds derived progress events when source
  gameplay events already provide the necessary history.
- **Direct Village writes or calls for delivery:** Break module ownership or risk
  losing delivery between claim persistence and the resource operation.
- **Scheduled reset:** Adds scheduling and recovery concerns without improving
  UTC date-based eligibility.

## Reconsideration

Reconsider if projection lag or reconstruction cost becomes unacceptable,
Village lifecycle rules change, delivery requires stronger recovery guarantees,
or pseudonymous retention no longer meets the project's privacy requirements.

## Generative AI Usage

- **Tools:** ChatGPT and Codex (OpenAI).
- **Contribution:** Initial proposal, repository review and ADR refinement.
- **Verification:** Decisions checked against existing contracts and platform
  behavior; implementation guarantees remain to be validated through tests.
