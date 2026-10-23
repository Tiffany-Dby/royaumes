import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REALM_TOPICS, villageChannel } from '@/modules/realm/contracts'
import { createTestDatabase, type Db } from '@/platform/db/client'
import {
  ConcurrencyError,
  createEventStore,
  type EventStore,
} from '@/platform/event-store/event-store'
import { outbox } from '@/platform/outbox/schema'
import { createProjectionRunner, type ProjectionRunner } from '@/platform/projection/projection'
import { createClaimService } from '../application/claim-service'
import { claimStream, claimTransferId, QUESTS_TOPICS } from '../contracts'
import { questDayAt } from '../domain/quest-day'
import { createQuestsHandlers } from '../messages'
import { createDrizzleClaimEligibilityReader } from './drizzle-claim-eligibility-reader'
import { createEventStoreClaimRepository } from './event-store-claim-repository'
import { progressProjection } from './progress-projection'

const T0 = Date.UTC(2026, 9, 23, 12)
const MIDNIGHT = Date.UTC(2026, 9, 24)
const key = { playerId: 'alice', questId: 'builder' as const, day: questDayAt(T0) }

let db: Db
let store: EventStore
let runner: ProjectionRunner
let repo: ReturnType<typeof createEventStoreClaimRepository>
let reader: ReturnType<typeof createDrizzleClaimEligibilityReader>
let service: ReturnType<typeof createClaimService>
let now: number

beforeEach(async () => {
  db = await createTestDatabase()
  store = createEventStore(db)
  runner = createProjectionRunner(db)
  repo = createEventStoreClaimRepository(store)
  reader = createDrizzleClaimEligibilityReader(db, runner, store)
  now = T0
  service = createClaimService(repo, reader, () => now)
})

afterEach(() => vi.restoreAllMocks())

async function activity({ village = true, upgrades = 2 } = {}) {
  await store.append(villageChannel('alice'), 0, [
    ...(village
      ? [{ type: 'VillageFounded', data: { name: 'Private village', at: T0 - 7_200_000 } }]
      : []),
    ...Array.from({ length: upgrades }, (_, index) => ({
      type: 'BuildingUpgraded',
      data: {
        building: 'sawmill',
        toLevel: index + 2,
        cost: { wood: index === 0 ? 98 : 167, stone: index === 0 ? 49 : 84 },
        at: T0 - 3_600_000 + index * 3_600_000,
      },
    })),
  ])
}

async function accepted() {
  await activity()
  const result = await service.claim('alice', 'builder')
  if (!result.ok) throw new Error(result.error.code)
  return result.claim
}

describe('Claim persistence and confirmation', () => {
  it('atomically records the reward snapshot and one namespaced deposit with replyTo', async () => {
    const claim = await accepted()
    expect(claim).toEqual({
      ...key,
      reward: { resource: 'wood', amount: 50 },
      acceptedAt: T0,
      transferId: claimTransferId(key),
    })
    expect(await store.read(claimStream(key))).toMatchObject([
      { type: 'QuestRewardClaimAccepted', data: claim },
    ])
    expect(await db.select().from(outbox)).toMatchObject([
      {
        topic: REALM_TOPICS.deposit,
        payload: {
          transferId: claim.transferId,
          playerId: 'alice',
          resources: { wood: 50 },
          replyTo: QUESTS_TOPICS.transferResult,
        },
      },
    ])
    expect(await service.claim('bob', 'builder')).toEqual({
      ok: false,
      error: { code: 'VILLAGE_REQUIRED' },
    })
  })

  it.each([
    [{ village: false }, 'VILLAGE_REQUIRED'],
    [{ upgrades: 1 }, 'QUEST_INCOMPLETE'],
  ] as const)('reads eligibility from projected gameplay (%j)', async (options, code) => {
    await activity(options)
    expect(await service.claim('alice', 'builder')).toEqual({ ok: false, error: { code } })
    expect(await store.read(claimStream(key))).toEqual([])
    expect(await db.select().from(outbox)).toEqual([])
  })

  it('preserves a historical reward snapshot and confirms it after midnight without reading projections', async () => {
    const original = {
      ...key,
      reward: { resource: 'wood', amount: 17 },
      acceptedAt: T0,
      transferId: claimTransferId(key),
    }
    await store.append(claimStream(key), 0, [{ type: 'QuestRewardClaimAccepted', data: original }])
    vi.spyOn(reader, 'read').mockRejectedValue(new Error('projection unavailable'))
    expect(await service.claim('alice', 'builder')).toEqual({
      ok: false,
      error: { code: 'ALREADY_CLAIMED' },
    })
    now = MIDNIGHT
    await service.confirm({ transferId: original.transferId, outcome: 'deposited' })
    expect((await repo.load(claimStream(key))).state.accepted).toEqual(original)
    expect(await db.select().from(outbox)).toEqual([])
  })

  it('serializes concurrent claims without a second event or deposit request', async () => {
    await activity()
    const load = repo.load.bind(repo)
    let arrived = 0
    let release!: () => void
    const bothLoaded = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(repo, 'load').mockImplementation(async (stream) => {
      const result = await load(stream)
      if (result.version === 0 && ++arrived <= 2) {
        if (arrived === 2) release()
        await bothLoaded
      }
      return result
    })
    const results = await Promise.all([
      service.claim('alice', 'builder'),
      service.claim('alice', 'builder'),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: 'ALREADY_CLAIMED' } },
    ])
    expect(await service.claim('alice', 'builder')).toEqual({
      ok: false,
      error: { code: 'ALREADY_CLAIMED' },
    })
    expect(await store.read(claimStream(key))).toHaveLength(1)
    expect(await db.select().from(outbox)).toHaveLength(1)
  })

  it('rolls back acceptance when outbox insertion fails and allows a later retry', async () => {
    await activity()
    await db.execute(
      sql`ALTER TABLE platform.outbox ADD CONSTRAINT reject_test_deposit CHECK (topic <> 'realm.deposit')`,
    )
    try {
      await expect(service.claim('alice', 'builder')).rejects.toThrow()
      expect(await store.read(claimStream(key))).toEqual([])
      expect(await db.select().from(outbox)).toEqual([])
    } finally {
      await db.execute(sql`ALTER TABLE platform.outbox DROP CONSTRAINT reject_test_deposit`)
    }
    expect((await service.claim('alice', 'builder')).ok).toBe(true)
    expect(await db.select().from(outbox)).toHaveLength(1)
  })

  it('returns not-ready without writing when catch-up stops at a journal gap', async () => {
    await activity()
    await expect(
      store.append(villageChannel('alice'), 0, [{ type: 'UnrelatedEvent', data: {} }]),
    ).rejects.toBeInstanceOf(ConcurrencyError)
    await store.append('unrelated', 0, [{ type: 'UnrelatedEvent', data: {} }])
    expect(await service.claim('alice', 'builder')).toEqual({
      ok: false,
      error: { code: 'QUESTS_NOT_READY' },
    })
    expect(await store.read(claimStream(key))).toEqual([])
    expect(await db.select().from(outbox)).toEqual([])
  })

  it('checks expiration after catch-up instead of using the request start time', async () => {
    await activity()
    const read = reader.read.bind(reader)
    vi.spyOn(reader, 'read').mockImplementation(async (identity) => {
      const facts = await read(identity)
      now = MIDNIGHT
      return facts
    })
    expect(await service.claim('alice', 'builder')).toEqual({
      ok: false,
      error: { code: 'NOT_CURRENT_DAY' },
    })
    expect(await store.read(claimStream(key))).toEqual([])
    expect(await db.select().from(outbox)).toEqual([])
  })

  it('rechecks expiration on an optimistic retry while keeping the original quest day', async () => {
    await activity()
    const load = vi.spyOn(repo, 'load')
    vi.spyOn(repo, 'save').mockImplementationOnce(async () => {
      now = MIDNIGHT
      throw new ConcurrencyError(claimStream(key), 0)
    })
    expect(await service.claim('alice', 'builder')).toEqual({
      ok: false,
      error: { code: 'NOT_CURRENT_DAY' },
    })
    expect(load).toHaveBeenCalledTimes(2)
    expect(await store.read(claimStream(key))).toEqual([])
    expect(await db.select().from(outbox)).toEqual([])
  })

  it('confirms delivery after midnight and handles repeated and concurrent confirmations idempotently', async () => {
    const claim = await accepted()
    now = MIDNIGHT
    const message = { transferId: claim.transferId, outcome: 'deposited' as const }
    await Promise.all([service.confirm(message), service.confirm(message)])
    await service.confirm(message)
    expect(
      (await store.read(claimStream(key))).map((event) => ({ type: event.type, data: event.data })),
    ).toEqual([
      { type: 'QuestRewardClaimAccepted', data: claim },
      { type: 'QuestRewardDelivered', data: { transferId: claim.transferId, at: MIDNIGHT } },
    ])
    expect(await db.select().from(outbox)).toHaveLength(1)
  })

  it.each(['refused', 'withdrawn', 'unknown'])(
    'rejects a %s confirmation without changing the claim',
    async (outcome) => {
      const claim = await accepted()
      const handler = createQuestsHandlers(service)[QUESTS_TOPICS.transferResult]
      await expect(
        handler({
          id: 'reply',
          attempt: 1,
          topic: QUESTS_TOPICS.transferResult,
          payload: { transferId: claim.transferId, outcome },
        }),
      ).rejects.toThrow()
      expect(await store.read(claimStream(key))).toHaveLength(1)
    },
  )

  it('rejects confirmations without an accepted claim or with a mismatched exact transfer ID', async () => {
    await expect(
      service.confirm({ transferId: claimTransferId(key), outcome: 'deposited' }),
    ).rejects.toThrow()
    await expect(
      service.confirm({ transferId: 'unrelated', outcome: 'deposited' }),
    ).rejects.toThrow()
    await store.append(claimStream(key), 0, [
      {
        type: 'QuestRewardClaimAccepted',
        data: {
          ...key,
          reward: { resource: 'wood', amount: 50 },
          acceptedAt: T0,
          transferId: 'different-transfer',
        },
      },
    ])
    await expect(
      service.confirm({ transferId: claimTransferId(key), outcome: 'deposited' }),
    ).rejects.toThrow()
    expect(await store.read(claimStream(key))).toHaveLength(1)
  })

  it('rebuilds projections without enqueuing deposits or changing accepted claim history', async () => {
    const claim = await accepted()
    const messages = await db.select().from(outbox)
    await runner.rebuild(progressProjection)
    await runner.rebuild(progressProjection)
    expect(await db.select().from(outbox)).toEqual(messages)
    expect((await repo.load(claimStream(key))).state.accepted).toEqual(claim)
  })

  it('keeps player, day and quest identities distinct', () => {
    const keys = [
      key,
      { ...key, playerId: 'alice:other' },
      { ...key, day: questDayAt(MIDNIGHT) },
      { ...key, questId: 'merchant' as const },
    ]
    expect(new Set(keys.map(claimStream)).size).toBe(4)
    expect(new Set(keys.map(claimTransferId)).size).toBe(4)
  })
})
