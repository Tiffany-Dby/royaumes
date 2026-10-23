# ADR-0010 - Event Sourcing and CQRS for Daily Quests

- Status: proposed
- Date: 2026-10-21

## Context

Daily Quests tracks player activity across Village, Dungeon and Market. Progress resets daily, while reward claims must remain durable and cannot be repeated.

The project already provides an Event Store, a versioned projection runner and a transactional outbox.

The module needs to track gameplay progress efficiently while guaranteeing that rewards are granted at most once.

## Decision

The module will combine **Event Sourcing for reward claims** with **CQRS for quest progress**.

- A versioned projection will consume `BuildingUpgraded`, `GameEnded` and `TradeCompleted` events to maintain daily progress in the `quests` database schema.
- Quest days will be identified by their UTC date, eliminating the need for a scheduled reset.
- Reward claims will be recorded in quest-owned event streams, using optimistic concurrency control to prevent duplicate claims.
- Accepted claims and resource deposit messages will be persisted atomically through the transactional outbox.
- Village will process deposits idempotently using a deterministic transfer identifier. Delivery confirmation will distinguish pending from delivered rewards.
- Before accepting a claim, Quests will catch up its projection and verify completion, ownership and expiration.

## Consequences

### Positive

- Quest progress can be rebuilt from existing gameplay events.
- Claims are durable, auditable and protected against concurrent requests.
- Resource delivery reuses existing messaging infrastructure.
- Daily resets require no background task.

### Negative

- Maintaining both Event Sourcing and a projection increases complexity.
- Progress and reward delivery may be temporarily inconsistent.
- Claim validation must account for projection lag and concurrent gameplay.
- Additional tests are needed for retries, concurrency and UTC boundaries.

## Alternatives Rejected

**Conventional tables only:** Simpler for claim status and uniqueness, but would still require reliable event consumption and transactional reward messaging.

**Event Sourcing only:** Avoids a separate persistence model but requires recording and replaying additional quest progress events derived from other modules.

**Scheduled daily reset:** Requires a background task and recovery from missed executions, whereas UTC date-based periods provide the same behavior without one.

## Reconsideration

Reconsider if projection catch-up becomes too expensive or the combined persistence model proves unnecessarily complex.

## Generative AI Usage

- **Tool:** ChatGPT (OpenAI).
- **Contribution:** Architecture comparison and ADR drafting.
- **Verification:** Reviewed against existing project contracts; implementation and concurrency guarantees will be validated through tests.