import { asc } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { villageChannel } from '@/modules/realm/contracts'
import { createTestDatabase, type Db } from '@/platform/db/client'
import {
  ConcurrencyError,
  createEventStore,
  type EventStore,
  type NewEvent,
} from '@/platform/event-store/event-store'
import {
  createProjectionRunner,
  type Projection,
  type ProjectionRunner,
} from '@/platform/projection/projection'
import { projections } from '@/platform/projection/schema'
import { progressProjection } from './progress-projection'
import { dailyProgress } from './schema'

const T0 = Date.UTC(2026, 9, 23)
const NEXT_DAY = Date.UTC(2026, 9, 24)

let db: Db
let store: EventStore
let runner: ProjectionRunner
beforeEach(async () => {
  db = await createTestDatabase()
  store = createEventStore(db)
  runner = createProjectionRunner(db, { batchSize: 2 })
})

/** Published Village fields consumed by Quests; no internal Village types are needed. */
const upgraded = (at = T0): NewEvent => ({
  type: 'BuildingUpgraded',
  data: { building: 'sawmill', toLevel: 2, cost: { wood: 98, stone: 49 }, at },
})

const rows = () =>
  db
    .select()
    .from(dailyProgress)
    .orderBy(asc(dailyProgress.playerId), asc(dailyProgress.day), asc(dailyProgress.questId))

const progress = (playerId: string, day = '2026-10-23', count = 1) => ({
  playerId,
  day,
  questId: 'builder',
  count,
})

describe('Builder progress projection', () => {
  it('starts empty and records a versioned checkpoint', async () => {
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([])
    expect(await db.select().from(projections)).toMatchObject([
      { name: 'quests-progress', version: 1, position: 0 },
    ])
  })

  it('counts building upgrades incrementally for the stream owner only', async () => {
    await store.append(villageChannel('alice'), 0, [
      { ...upgraded(), data: { ...upgraded().data, playerId: 'bob' } },
    ])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([progress('alice')])

    await store.append(villageChannel('alice'), 1, [upgraded(T0 + 1000)])
    await store.append(villageChannel('bob'), 0, [upgraded()])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([progress('alice', '2026-10-23', 2), progress('bob')])
    expect(await runner.positionOf(progressProjection.name)).toBe(await store.lastPosition())
  })

  it('caps Builder progress at two upgrades', async () => {
    await store.append(villageChannel('alice'), 0, [upgraded(), upgraded(), upgraded()])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([progress('alice', '2026-10-23', 2)])
  })

  it('uses gameplay time even when recording time and event arrival order differ', async () => {
    const [stored] = await store.append(villageChannel('alice'), 0, [upgraded(NEXT_DAY)])
    // The database clock remains independent of the historical gameplay timestamp.
    expect(stored.occurredAt.getTime()).not.toBe(NEXT_DAY)
    await store.append(villageChannel('alice'), 1, [upgraded(NEXT_DAY - 1)])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([progress('alice'), progress('alice', '2026-10-24')])
  })

  it('keeps midnight progress separate without a reset task', async () => {
    await store.append(villageChannel('alice'), 0, [
      upgraded(NEXT_DAY - 2),
      upgraded(NEXT_DAY - 1),
      upgraded(NEXT_DAY),
      upgraded(NEXT_DAY + 1),
      upgraded(NEXT_DAY + 2),
    ])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([
      progress('alice', '2026-10-23', 2),
      progress('alice', '2026-10-24', 2),
    ])
  })

  it('ignores unrelated events while advancing the checkpoint', async () => {
    await store.append(villageChannel('alice'), 0, [
      { type: 'VillageFounded', data: { name: 'Private village', at: T0 } },
      { type: 'ResourcesDeposited', data: { at: T0 } },
    ])
    await store.append('dungeon-g1', 0, [{ type: 'GameEnded', data: { at: T0 } }])
    await store.append('market-o1', 0, [{ type: 'TradeCompleted', data: { at: T0 } }])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([])
    expect(await runner.positionOf(progressProjection.name)).toBe(await store.lastPosition())
  })

  it('ignores upgrade events outside a nonempty Village stream', async () => {
    for (const stream of [
      'dungeon-alice',
      'market-alice',
      'other-village-alice',
      'village',
      'village-',
    ]) {
      // Unrelated streams must be ignored before interpreting their payload.
      await store.append(stream, 0, [{ type: 'BuildingUpgraded', data: {} }])
    }
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([])
    expect(await runner.positionOf(progressProjection.name)).toBe(await store.lastPosition())
  })

  it('does not recount events on repeated or concurrent catch-up', async () => {
    await store.append(villageChannel('alice'), 0, [upgraded()])
    await Promise.all([runner.catchUp(progressProjection), runner.catchUp(progressProjection)])
    expect(await rows()).toEqual([progress('alice')])
    const checkpoint = await db.select().from(projections)
    expect(await runner.catchUp(progressProjection)).toBe(0)
    expect(await rows()).toEqual([progress('alice')])
    expect(await db.select().from(projections)).toEqual(checkpoint)
  })

  it.each([undefined, null, '2026-10-23', Number.MAX_VALUE])(
    'rolls back progress and checkpoint creation for invalid gameplay time %s',
    async (at) => {
      await store.append(villageChannel('alice'), 0, [upgraded()])
      await store.append(villageChannel('bob'), 0, [{ type: 'BuildingUpgraded', data: { at } }])
      await expect(runner.catchUp(progressProjection)).rejects.toThrow(RangeError)
      expect(await rows()).toEqual([])
      expect(await db.select().from(projections)).toEqual([])
    },
  )

  it('preserves earlier progress and checkpoint when a later batch fails', async () => {
    await store.append(villageChannel('alice'), 0, [upgraded()])
    await runner.catchUp(progressProjection)
    const before = await rows()
    const checkpoint = await db.select().from(projections)

    await store.append(villageChannel('bob'), 0, [upgraded()])
    await store.append(villageChannel('carol'), 0, [upgraded()])
    await store.append(villageChannel('dave'), 0, [{ type: 'BuildingUpgraded', data: {} }])
    await expect(runner.catchUp(progressProjection)).rejects.toThrow(RangeError)
    expect(await rows()).toEqual(before)
    expect(await db.select().from(projections)).toEqual(checkpoint)
  })

  it('reconstructs all historical days to the same progress without writing events', async () => {
    await store.append(villageChannel('alice'), 0, [upgraded(T0), upgraded(NEXT_DAY)])
    await runner.catchUp(progressProjection)
    await store.append(villageChannel('bob'), 0, [upgraded(T0)])
    await runner.catchUp(progressProjection)
    const before = await rows()
    const journal = await store.readAll({})

    await runner.rebuild(progressProjection)
    expect(await rows()).toEqual(before)
    expect(await runner.positionOf(progressProjection.name)).toBe(await store.lastPosition())
    expect(await store.readAll({})).toEqual(journal)
    expect(await runner.catchUp(progressProjection)).toBe(0)
  })

  it('rebuilds the projection when its version increases', async () => {
    await store.append(villageChannel('alice'), 0, [upgraded()])
    await runner.catchUp(progressProjection)
    // Stale derived data must not survive reconstruction after a version change.
    await db.update(dailyProgress).set({ count: 0 })
    const nextVersion = { ...progressProjection, version: progressProjection.version + 1 }
    await runner.catchUp(nextVersion)
    expect(await rows()).toEqual([progress('alice')])
    expect(await db.select().from(projections)).toMatchObject([
      { version: nextVersion.version, position: await store.lastPosition() },
    ])
  })

  it('rolls back reset, replay writes and checkpoint changes when reconstruction fails', async () => {
    await store.append(villageChannel('alice'), 0, [upgraded()])
    await runner.catchUp(progressProjection)
    const before = await rows()
    const checkpoint = await db.select().from(projections)
    await store.append(villageChannel('bob'), 0, [upgraded()])

    const failing: Projection = {
      ...progressProjection,
      version: progressProjection.version + 1,
      async apply(event, tx) {
        await progressProjection.apply(event, tx)
        if (event.stream === villageChannel('bob')) throw new Error('Interrupted reconstruction')
      },
    }
    await expect(runner.rebuild(failing)).rejects.toThrow('Interrupted reconstruction')
    expect(await rows()).toEqual(before)
    expect(await db.select().from(projections)).toEqual(checkpoint)

    await runner.rebuild(progressProjection)
    expect(await rows()).toEqual([progress('alice'), progress('bob')])
  })

  it('respects the platform position-gap grace period before resuming', async () => {
    await store.append(villageChannel('alice'), 0, [upgraded()])
    await expect(store.append(villageChannel('alice'), 0, [upgraded()])).rejects.toBeInstanceOf(
      ConcurrencyError,
    )
    await store.append(villageChannel('bob'), 0, [upgraded()])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([progress('alice')])
    expect(await runner.positionOf(progressProjection.name)).toBe(1)

    const later = createProjectionRunner(db, { now: () => Date.now() + 10_000 })
    await later.catchUp(progressProjection)
    expect(await rows()).toEqual([progress('alice'), progress('bob')])
    expect(await later.positionOf(progressProjection.name)).toBe(await store.lastPosition())
  })
})
