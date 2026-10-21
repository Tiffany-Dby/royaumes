# Framing Document: Daily Quests

- **Author:** Tiffany DBEISSY
- **Date:** 2026-10-21
- **Technical module name:** `quests`

## The Idea

Daily Quests introduces a system of daily objectives that encourages players to engage with the existing gameplay mechanics of Royaumes.

Each player receives the same three quests every day, involving activities in the Village, Dungeon and Market modules.

Players complete quests by performing normal gameplay actions. Once a quest is completed, they can manually claim a reward consisting of Village resources: wood, stone or gold.

Quests reset daily at 00:00 UTC. Progress does not carry over between days, and unclaimed rewards expire when the day ends.

## Business Rules

**BR-01 - Daily quest assignment**

Each player receives three predefined daily quests. All players receive the same objectives and rewards for a given day.

**BR-02 - Daily reset**

A quest day begins at 00:00 UTC and ends immediately before the following 00:00 UTC. At the beginning of a new day, quest progress resets to zero without requiring a background task.

**BR-03 - Progress eligibility**

Only gameplay events occurring during the current quest day contribute to quest progress. Each eligible gameplay action contributes at most once to the corresponding quest.

**BR-04 - The Builder**

A player completes *The Builder* by successfully upgrading two Village buildings during the current quest day.

The quest observes `BuildingUpgraded` events and rewards 50 wood.

**BR-05 - The Adventurer**

A player completes *The Adventurer* by finishing one Dungeon expedition during the current quest day, regardless of whether the expedition was won or lost.

The quest observes `GameEnded` events. Progress is granted to participating human players, excluding AI companions.

The reward is 75 stone.

**BR-06 - The Merchant**

A player completes *The Merchant* by participating in one successfully completed Market trade during the current quest day.

The quest observes `TradeCompleted` events. Both the seller and buyer receive progress.

The reward is 100 gold.

**BR-07 - Quest completion**

Quest progress cannot exceed its required objective. Once the objective is reached, the quest becomes completed and its reward becomes available for claiming.

**BR-08 - Manual reward claiming**

Rewards are not granted automatically. The player must explicitly claim a completed quest's reward before the end of its quest day.

**BR-09 - Reward eligibility**

A player must have an existing Village to claim a reward. An incomplete, expired or already claimed quest cannot be claimed.

**BR-10 - Reward distribution**

Rewards are delivered to the player's Village through the existing transactional outbox and the Village's published resource deposit contract.

The Quests module never modifies Village resources directly.

**BR-11 - Idempotency**

Each reward has a unique transfer identifier. Repeated claim requests, concurrent requests or repeated message deliveries must never credit the same reward more than once.

**BR-12 - Reward settlement**

A successfully accepted claim is recorded durably. Reward delivery may be asynchronous, and the module distinguishes a pending reward from a delivered reward.

Temporary delivery failures must not create duplicate rewards or silently discard accepted claims.

## Commands and Queries

| Player action                    | Command or query            | Planned route                |
| -------------------------------- | --------------------------- | ---------------------------- |
| View today's quests and progress | Query: `GetDailyQuests`     | `GET /api/quests`            |
| Claim a completed quest reward   | Command: `ClaimQuestReward` | `POST /api/quests/:id/claim` |

Quest progress is updated internally from gameplay events rather than through player-submitted progress commands.

All routes require authentication. The server derives the player identity from the authenticated session.

## Proposed Storage

The module will use a combination of Event Sourcing and a dedicated CQRS read model.

**Event Sourcing** will record important quest lifecycle events, particularly reward claims and settlement outcomes. These events provide a durable history of rewarded quests and support future consumers without introducing dependencies on them.

**CQRS projections** will maintain daily progress and reward status in tables belonging to the `quests` database schema.

The projection will consume published events from existing modules and maintain its own checkpoint and version, allowing it to catch up and rebuild when necessary.

Daily resets will be handled through the quest-day identifier rather than by deleting all progress at midnight.

The exact storage design and consistency guarantees will be justified in an ADR before implementation.

## Communication With Existing Modules

### Village (`realm`)

The Quests module observes published `BuildingUpgraded` events to track building upgrades.

When a player claims a reward, Quests publishes a resource deposit request through the transactional outbox using the Village's existing `REALM_TOPICS.deposit` contract.

The Village handles the deposit and ensures idempotency through the transfer identifier.

### Dungeon (`dungeon`)

The Quests module observes published `GameEnded` events to identify completed expeditions and credit progress to participating human players.

### Market (`market`)

The Quests module observes published `TradeCompleted` events to identify successful exchanges and credit progress to both participants.

### Communication Principles

- Modules communicate exclusively through published contracts and platform mechanisms.
- Quests does not import internal implementation files from other modules.
- Event processing and reward distribution must be idempotent.
- Asynchronous operations may introduce temporary consistency delays.
- No existing module's internal storage is modified directly by Quests.

## Personal Data

The module stores or references:

- Player identifiers.
- Daily quest progress.
- Quest completion and claim history.
- Reward delivery status.

The module will provide `src/modules/quests/personal-data.ts`, participating in the existing personal-data export and account-deletion mechanisms.

Player-related data will be included in account exports and erased or anonymized as appropriate when an account is deleted.

If necessary, the GDPR processing register will be updated to describe the new processing activity.

## Intended Bonuses

The following bonuses are targeted, in priority order:

| Bonus              | Description                                                            | Points |
| ------------------ | ---------------------------------------------------------------------- | -----: |
| B4                 | CQRS projection with checkpoint and version                            |     +1 |
| B6                 | Communication with at least two existing modules                       |     +1 |
| B2                 | Daily reset without a background task                                  |     +1 |
| B1                 | Module-specific real-time updates with access control                  |     +1 |
| B8                 | Additional architecture fitness function protecting a Quests invariant |     +1 |
| **Total targeted** |                                                                        |  **5** |

