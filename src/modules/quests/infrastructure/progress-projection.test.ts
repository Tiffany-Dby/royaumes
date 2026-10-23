import { asc } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { gameChannel } from '@/modules/dungeon/contracts'
import { offerStream } from '@/modules/market/contracts'
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
import { dailyProgress, gamePlayers, tradeParticipants } from './schema'

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
      { name: 'quests-progress', version: 3, position: 0 },
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
    await store.append('dungeon-g1', 0, [{ type: 'GameStarted', data: { rooms: [], at: T0 } }])
    await store.append('market-o1', 0, [{ type: 'OfferOpened', data: { at: T0 } }])
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

const created = (hostId = 'alice', at = T0): NewEvent => ({
  type: 'GameCreated',
  data: {
    hostId,
    hostName: `Private name of ${hostId}`,
    hero: { hp: 30, attack: 6 },
    difficulty: 'easy',
    seed: 42,
    at,
  },
})

const joined = (playerId = 'bob', at = T0): NewEvent => ({
  type: 'PlayerJoined',
  data: { playerId, name: `Private name of ${playerId}`, hero: { hp: 30, attack: 6 }, at },
})

const companion: NewEvent = {
  type: 'CompanionAdded',
  data: {
    companionId: 'companion-1',
    name: 'Private companion',
    hero: { hp: 30, attack: 6 },
    at: T0,
  },
}

const ended = (result: 'won' | 'lost' = 'won', heroIds = ['alice'], at = T0): NewEvent => ({
  type: 'GameEnded',
  data: { result, loot: 25, heroIds, at },
})

const participants = () =>
  db.select().from(gamePlayers).orderBy(asc(gamePlayers.gameId), asc(gamePlayers.playerId))

const adventurer = (playerId: string, day = '2026-10-23') => ({
  playerId,
  day,
  questId: 'adventurer',
  count: 1,
})

const published = (offerId = 'o1', sellerId = 'alice', at = T0): NewEvent => ({
  type: 'OfferPublished',
  data: {
    offerId,
    sellerId,
    sellerName: `Private name of ${sellerId}`,
    give: { wood: 60 },
    want: { stone: 30 },
    at,
    expiresAt: at + 24 * 60 * 60_000,
  },
})

const opened: NewEvent = { type: 'OfferOpened', data: { at: T0 } }
const accepted = (buyerId = 'bob', attempt = 1, at = T0): NewEvent => ({
  type: 'OfferAccepted',
  data: { buyerId, buyerName: `Private name of ${buyerId}`, attempt, at },
})
const paymentRefused = (buyerId = 'bob'): NewEvent => ({
  type: 'PaymentRefused',
  data: { buyerId, missing: { stone: 30 }, at: T0 },
})
const completed = (at = T0): NewEvent => ({ type: 'TradeCompleted', data: { at } })
const trades = () => db.select().from(tradeParticipants).orderBy(asc(tradeParticipants.offerId))
const merchant = (playerId: string, day = '2026-10-23') => ({
  playerId,
  day,
  questId: 'merchant',
  count: 1,
})

describe('Merchant progress projection', () => {
  it('credits both participants only after a successful trade and removes its context', async () => {
    await store.append(offerStream('o1'), 0, [published()])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([])
    expect(await trades()).toEqual([{ offerId: 'o1', sellerId: 'alice', buyerId: null }])
    await store.append(offerStream('o1'), 1, [opened, accepted()])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([])
    expect(await trades()).toEqual([{ offerId: 'o1', sellerId: 'alice', buyerId: 'bob' }])
    await store.append(offerStream('o1'), 3, [completed()])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([merchant('alice'), merchant('bob')])
    expect(await trades()).toEqual([])
  })

  it.each([
    { failedBuyers: ['bob'] },
    { failedBuyers: ['bob', 'dave'] },
    { failedBuyers: ['bob', 'bob'] },
  ])(
    'clears each failed buyer in $failedBuyers before crediting Carol',
    async ({ failedBuyers }) => {
      await store.append(offerStream('o1'), 0, [published(), opened])
      let version = 2
      for (const [index, buyer] of failedBuyers.entries()) {
        await store.append(offerStream('o1'), version, [
          accepted(buyer, index + 1),
          paymentRefused(buyer),
        ])
        version += 2
        await runner.catchUp(progressProjection)
        expect(await rows()).toEqual([])
        expect(await trades()).toEqual([{ offerId: 'o1', sellerId: 'alice', buyerId: null }])
      }
      await store.append(offerStream('o1'), version, [
        accepted('carol', failedBuyers.length + 1),
        completed(),
      ])
      await runner.catchUp(progressProjection)
      expect(await rows()).toEqual([merchant('alice'), merchant('carol')])
      expect(await trades()).toEqual([])
    },
  )

  it('credits a buyer who succeeds after their own earlier failed payment', async () => {
    await store.append(offerStream('o1'), 0, [
      published(),
      opened,
      accepted(),
      paymentRefused(),
      accepted('bob', 2),
      completed(),
    ])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([merchant('alice'), merchant('bob')])
  })

  it.each([
    { type: 'OfferRejected', data: { missing: { wood: 500 }, at: T0 } },
    { type: 'OfferWithdrawn', data: { reason: 'seller', at: T0 } },
    { type: 'OfferWithdrawn', data: { reason: 'expired', at: T0 + 24 * 60 * 60_000 } },
  ])('cleans up $type without granting progress', async (terminal) => {
    await store.append(offerStream('o1'), 0, [
      published(),
      ...(terminal.type === 'OfferRejected' ? [] : [opened]),
      terminal,
    ])
    await runner.catchUp(progressProjection)
    expect(await trades()).toEqual([])
    expect(await rows()).toEqual([])
  })

  it('cleans up an offer withdrawn after payment refusal', async () => {
    await store.append(offerStream('o1'), 0, [
      published(),
      opened,
      accepted(),
      paymentRefused(),
      { type: 'OfferWithdrawn', data: { reason: 'expired', at: NEXT_DAY } },
    ])
    await runner.catchUp(progressProjection)
    expect(await trades()).toEqual([])
    expect(await rows()).toEqual([])
  })

  it('retains participants across midnight and uses completion gameplay time', async () => {
    await store.append(offerStream('o1'), 0, [
      published('o1', 'alice', NEXT_DAY - 1000),
      { type: 'OfferOpened', data: { at: NEXT_DAY - 1000 } },
      accepted('bob', 1, NEXT_DAY - 1),
    ])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([])
    expect(await trades()).toEqual([{ offerId: 'o1', sellerId: 'alice', buyerId: 'bob' }])
    await store.append(offerStream('o1'), 3, [completed(NEXT_DAY)])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([merchant('alice', '2026-10-24'), merchant('bob', '2026-10-24')])
    expect(await trades()).toEqual([])
  })

  it('isolates trades, players and days while capping Merchant progress at one', async () => {
    for (const [offerId, seller, buyer, at] of [
      ['o1', 'alice', 'bob', T0],
      ['o2', 'alice', 'carol', T0],
      ['o3', 'dave', 'bob', T0],
      ['o4', 'alice', 'bob', NEXT_DAY],
    ] as const) {
      await store.append(offerStream(offerId), 0, [
        published(offerId, seller, at),
        { type: 'OfferOpened', data: { at } },
        accepted(buyer, 1, at),
        completed(at),
      ])
    }
    await store.append(offerStream('o5'), 0, [published('o5', 'eric')])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([
      merchant('alice'),
      merchant('alice', '2026-10-24'),
      merchant('bob'),
      merchant('bob', '2026-10-24'),
      merchant('carol'),
      merchant('dave'),
    ])
    expect(await trades()).toEqual([{ offerId: 'o5', sellerId: 'eric', buyerId: null }])
  })

  it('ignores Market event types on unexpected or empty Market streams', async () => {
    for (const stream of ['village-alice', 'dungeon-g1', 'other-market-o1', 'market', 'market-']) {
      await store.append(
        stream,
        0,
        [
          'OfferPublished',
          'OfferAccepted',
          'PaymentRefused',
          'TradeCompleted',
          'OfferRejected',
          'OfferWithdrawn',
        ].map((type) => ({ type, data: {} })),
      )
    }
    await runner.catchUp(progressProjection)
    expect(await trades()).toEqual([])
    expect(await rows()).toEqual([])
    expect(await runner.positionOf(progressProjection.name)).toBe(await store.lastPosition())
  })

  it('does not duplicate participants or credits during concurrent and repeated catch-up', async () => {
    await store.append(offerStream('o1'), 0, [published(), opened, accepted()])
    await Promise.all([runner.catchUp(progressProjection), runner.catchUp(progressProjection)])
    expect(await trades()).toEqual([{ offerId: 'o1', sellerId: 'alice', buyerId: 'bob' }])
    await store.append(offerStream('o1'), 3, [completed()])
    await Promise.all([runner.catchUp(progressProjection), runner.catchUp(progressProjection)])
    expect(await rows()).toEqual([merchant('alice'), merchant('bob')])
    expect(await trades()).toEqual([])
    expect(await runner.catchUp(progressProjection)).toBe(0)
  })

  it.each([
    {
      name: 'missing seller',
      events: [{ ...published(), data: { ...published().data, sellerId: null } }],
    },
    { name: 'mismatched offer identifier', events: [published('other')] },
    { name: 'missing publication', events: [accepted()] },
    {
      name: 'missing buyer',
      events: [published(), opened, { ...accepted(), data: { ...accepted().data, buyerId: '' } }],
    },
    { name: 'invalid attempt', events: [published(), opened, accepted('bob', 0)] },
    { name: 'self acceptance', events: [published(), opened, accepted('alice')] },
    {
      name: 'acceptance during payment',
      events: [published(), opened, accepted(), accepted('carol', 2)],
    },
    {
      name: 'mismatched refusal',
      events: [published(), opened, accepted(), paymentRefused('carol')],
    },
    { name: 'completion without buyer', events: [published(), completed()] },
    {
      name: 'completion after refusal',
      events: [published(), opened, accepted(), paymentRefused(), completed()],
    },
    { name: 'completion without publication', events: [completed()] },
    {
      name: 'withdrawal during payment',
      events: [
        published(),
        opened,
        accepted(),
        { type: 'OfferWithdrawn', data: { reason: 'seller', at: T0 } },
      ],
    },
  ])('rejects $name rather than advancing past invalid attribution', async ({ events }) => {
    await store.append(offerStream('o1'), 0, events)
    await expect(runner.catchUp(progressProjection)).rejects.toThrow()
    expect(await trades()).toEqual([])
    expect(await rows()).toEqual([])
    expect(await db.select().from(projections)).toEqual([])
  })

  it.each([undefined, null, '2026-10-23', Number.MAX_VALUE])(
    'preserves participants and checkpoint for invalid completion time %s',
    async (at) => {
      await store.append(offerStream('o1'), 0, [published(), opened, accepted()])
      await runner.catchUp(progressProjection)
      const before = await trades()
      const checkpoint = await db.select().from(projections)
      await store.append(offerStream('o1'), 3, [{ type: 'TradeCompleted', data: { at } }])
      await expect(runner.catchUp(progressProjection)).rejects.toThrow(RangeError)
      expect(await rows()).toEqual([])
      expect(await trades()).toEqual(before)
      expect(await db.select().from(projections)).toEqual(checkpoint)
    },
  )

  it('rebuilds active Market context without changing Builder or Dungeon data', async () => {
    await store.append(villageChannel('dave'), 0, [upgraded()])
    await store.append(gameChannel('g1'), 0, [created('carol')])
    await store.append(offerStream('o1'), 0, [published(), opened, accepted(), completed()])
    await store.append(offerStream('o2'), 0, [published('o2'), opened, accepted('carol')])
    await runner.catchUp(progressProjection)
    const before = await rows()
    const active = await trades()
    const dungeon = await participants()
    await db.insert(tradeParticipants).values({ offerId: 'orphan', sellerId: 'eric' })
    await runner.rebuild(progressProjection)
    expect(await rows()).toEqual(before)
    expect(await trades()).toEqual(active)
    expect(await participants()).toEqual(dungeon)
    expect(await runner.catchUp(progressProjection)).toBe(0)
  })

  it('replays historical Market events when upgrading a Builder and Dungeon checkpoint', async () => {
    await store.append(villageChannel('dave'), 0, [upgraded()])
    await store.append(gameChannel('g1'), 0, [created('eric'), ended('lost', ['eric'])])
    await store.append(offerStream('o1'), 0, [
      published(),
      opened,
      accepted(),
      paymentRefused(),
      accepted('carol', 2),
      completed(),
    ])
    await store.append(offerStream('o2'), 0, [published('o2')])
    const previous: Projection = {
      ...progressProjection,
      version: 2,
      eventTypes: ['BuildingUpgraded', 'GameCreated', 'PlayerJoined', 'GameEnded'],
    }
    await runner.catchUp(previous)
    expect(await rows()).toEqual([progress('dave'), adventurer('eric')])
    expect(await trades()).toEqual([])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([
      merchant('alice'),
      merchant('carol'),
      progress('dave'),
      adventurer('eric'),
    ])
    expect(await trades()).toEqual([{ offerId: 'o2', sellerId: 'alice', buyerId: null }])
    expect(await db.select().from(projections)).toMatchObject([
      { version: 3, position: await store.lastPosition() },
    ])
  })

  it.each(['catchUp', 'rebuild'] as const)(
    'rolls back Market completion and all derived data if %s fails',
    async (mode) => {
      await store.append(villageChannel('dave'), 0, [upgraded()])
      await store.append(gameChannel('g1'), 0, [created('carol')])
      await store.append(offerStream('o1'), 0, [published(), opened, accepted()])
      await runner.catchUp(progressProjection)
      const before = await rows()
      const active = await trades()
      const dungeon = await participants()
      const checkpoint = await db.select().from(projections)
      await store.append(offerStream('o1'), 3, [completed()])
      const failing: Projection = {
        ...progressProjection,
        async apply(event, tx) {
          await progressProjection.apply(event, tx)
          if (event.type === 'TradeCompleted') throw new Error('Interrupted Market completion')
        },
      }
      await expect(runner[mode](failing)).rejects.toThrow('Interrupted Market completion')
      expect(await rows()).toEqual(before)
      expect(await trades()).toEqual(active)
      expect(await participants()).toEqual(dungeon)
      expect(await db.select().from(projections)).toEqual(checkpoint)
      await runner[mode](progressProjection)
      expect(await rows()).toEqual([merchant('alice'), merchant('bob'), progress('dave')])
      expect(await trades()).toEqual([])
      expect(await participants()).toEqual(dungeon)
    },
  )
})

describe('Adventurer progress projection', () => {
  it.each(['won', 'lost'] as const)('credits the human host of a %s expedition', async (result) => {
    await store.append(gameChannel('g1'), 0, [created(), ended(result)])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([adventurer('alice')])
    expect(await participants()).toEqual([])
  })

  it('retains unique human participants without names, companions or premature progress', async () => {
    await store.append(gameChannel('g1'), 0, [
      created(),
      joined(),
      joined(),
      joined('carol'),
      companion,
    ])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([])
    expect(await participants()).toEqual([
      { gameId: 'g1', playerId: 'alice' },
      { gameId: 'g1', playerId: 'bob' },
      { gameId: 'g1', playerId: 'carol' },
    ])

    await store.append(gameChannel('g1'), 5, [
      ended('lost', ['alice', 'bob', 'carol', 'companion-1']),
    ])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([adventurer('alice'), adventurer('bob'), adventurer('carol')])
    expect(await participants()).toEqual([])
  })

  it('identifies humans through membership events rather than identifier spelling', async () => {
    await store.append(gameChannel('g1'), 0, [
      created('companion-player'),
      companion,
      ended('won', ['companion-player', 'companion-1']),
    ])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([adventurer('companion-player')])
  })

  it('keeps membership across midnight and credits the gameplay completion day', async () => {
    await store.append(gameChannel('g1'), 0, [
      created('alice', NEXT_DAY - 1000),
      joined('bob', NEXT_DAY - 1),
    ])
    await runner.catchUp(progressProjection)
    expect(await participants()).toHaveLength(2)
    expect(await rows()).toEqual([])

    await store.append(gameChannel('g1'), 2, [ended('won', ['alice', 'bob'], NEXT_DAY)])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([
      adventurer('alice', '2026-10-24'),
      adventurer('bob', '2026-10-24'),
    ])
    expect(await participants()).toEqual([])
  })

  it('isolates games and days while capping progress and preserving Builder counters', async () => {
    await store.append(villageChannel('alice'), 0, [upgraded(), upgraded(), upgraded()])
    await store.append(gameChannel('g1'), 0, [created(), joined(), ended('lost', ['alice', 'bob'])])
    await store.append(gameChannel('g2'), 0, [
      created(),
      joined('carol'),
      ended('won', ['alice', 'carol']),
    ])
    await store.append(gameChannel('g3'), 0, [
      created('alice', NEXT_DAY),
      ended('won', ['alice'], NEXT_DAY),
    ])
    await store.append(gameChannel('g4'), 0, [created('dave')])
    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([
      adventurer('alice'),
      progress('alice', '2026-10-23', 2),
      adventurer('alice', '2026-10-24'),
      adventurer('bob'),
      adventurer('carol'),
    ])
    expect(await participants()).toEqual([{ gameId: 'g4', playerId: 'dave' }])
  })

  it('ignores Dungeon event types from unexpected or empty Dungeon streams', async () => {
    for (const stream of [
      'village-alice',
      'market-o1',
      'other-dungeon-g1',
      'dungeon',
      'dungeon-',
    ]) {
      await store.append(stream, 0, [
        { type: 'GameCreated', data: {} },
        { type: 'PlayerJoined', data: {} },
        { type: 'GameEnded', data: {} },
      ])
    }
    await runner.catchUp(progressProjection)
    expect(await participants()).toEqual([])
    expect(await rows()).toEqual([])
    expect(await runner.positionOf(progressProjection.name)).toBe(await store.lastPosition())
  })

  it('does not duplicate membership or progress on repeated and concurrent catch-up', async () => {
    await store.append(gameChannel('g1'), 0, [created(), joined()])
    await Promise.all([runner.catchUp(progressProjection), runner.catchUp(progressProjection)])
    expect(await participants()).toHaveLength(2)
    await store.append(gameChannel('g1'), 2, [ended('won', ['alice', 'bob'])])
    await Promise.all([runner.catchUp(progressProjection), runner.catchUp(progressProjection)])
    expect(await rows()).toEqual([adventurer('alice'), adventurer('bob')])
    expect(await participants()).toEqual([])
    expect(await runner.catchUp(progressProjection)).toBe(0)
  })

  it.each(
    [undefined, null, '', 42].flatMap((id) =>
      ['GameCreated', 'PlayerJoined'].map((type) => ({ type, id })),
    ),
  )('rejects an invalid human identifier in $type ($id) atomically', async ({ type, id }) => {
    await store.append(gameChannel(type), 0, [
      ...(type === 'PlayerJoined' ? [created()] : []),
      {
        type,
        data: {
          ...(type === 'GameCreated' ? created().data : joined().data),
          hostId: id,
          playerId: id,
        },
      },
    ])
    await expect(runner.catchUp(progressProjection)).rejects.toThrow('player identifier')
    expect(await participants()).toEqual([])
    expect(await rows()).toEqual([])
    expect(await db.select().from(projections)).toEqual([])
  })

  it.each([joined(), ended()])('rejects $type without recorded human membership', async (event) => {
    await store.append(gameChannel('g1'), 0, [event])
    await expect(runner.catchUp(progressProjection)).rejects.toThrow('participation context')
    expect(await participants()).toEqual([])
    expect(await rows()).toEqual([])
    expect(await db.select().from(projections)).toEqual([])
  })

  it.each([undefined, null, '2026-10-23', Number.MAX_VALUE])(
    'preserves membership and checkpoint when completion time %s is invalid',
    async (at) => {
      await store.append(gameChannel('g1'), 0, [created(), joined()])
      await runner.catchUp(progressProjection)
      const before = await participants()
      const checkpoint = await db.select().from(projections)
      await store.append(gameChannel('g1'), 2, [{ ...ended(), data: { ...ended().data, at } }])
      await expect(runner.catchUp(progressProjection)).rejects.toThrow(RangeError)
      expect(await participants()).toEqual(before)
      expect(await rows()).toEqual([])
      expect(await db.select().from(projections)).toEqual(checkpoint)
    },
  )

  it('rejects a completion without a valid expedition result', async () => {
    await store.append(gameChannel('g1'), 0, [
      created(),
      { ...ended(), data: { ...ended().data, result: 'unknown' } },
    ])
    await expect(runner.catchUp(progressProjection)).rejects.toThrow('result')
    expect(await participants()).toEqual([])
    expect(await rows()).toEqual([])
    expect(await db.select().from(projections)).toEqual([])
  })

  it('rebuilds completed progress and active membership from the same journal', async () => {
    await store.append(gameChannel('g1'), 0, [
      created(),
      joined(),
      companion,
      ended('lost', ['alice', 'bob', 'companion-1']),
    ])
    await store.append(gameChannel('g2'), 0, [created('carol')])
    await runner.catchUp(progressProjection)
    const before = await rows()
    const active = await participants()
    await db.insert(gamePlayers).values({ gameId: 'orphan', playerId: 'dave' })
    await runner.rebuild(progressProjection)
    expect(await rows()).toEqual(before)
    expect(await participants()).toEqual(active)
    expect(await runner.catchUp(progressProjection)).toBe(0)
  })

  it('replays historical Dungeon events when upgrading a Builder-only checkpoint', async () => {
    await store.append(villageChannel('alice'), 0, [upgraded()])
    await store.append(gameChannel('g1'), 0, [created(), ended()])
    await store.append(gameChannel('g2'), 0, [created('bob')])
    const builderOnly: Projection = {
      ...progressProjection,
      version: 1,
      eventTypes: ['BuildingUpgraded'],
    }
    await runner.catchUp(builderOnly)
    expect(await rows()).toEqual([progress('alice')])
    expect(await participants()).toEqual([])

    await runner.catchUp(progressProjection)
    expect(await rows()).toEqual([adventurer('alice'), progress('alice')])
    expect(await participants()).toEqual([{ gameId: 'g2', playerId: 'bob' }])
    expect(await db.select().from(projections)).toMatchObject([
      { version: 3, position: await store.lastPosition() },
    ])
  })

  it('rolls back counters, membership cleanup and checkpoint if completion is interrupted', async () => {
    await store.append(gameChannel('g1'), 0, [created(), joined()])
    await runner.catchUp(progressProjection)
    const before = await participants()
    const checkpoint = await db.select().from(projections)
    await store.append(gameChannel('g1'), 2, [ended('won', ['alice', 'bob'])])
    const failing: Projection = {
      ...progressProjection,
      async apply(event, tx) {
        await progressProjection.apply(event, tx)
        if (event.type === 'GameEnded') throw new Error('Interrupted completion')
      },
    }
    await expect(runner.catchUp(failing)).rejects.toThrow('Interrupted completion')
    expect(await participants()).toEqual(before)
    expect(await rows()).toEqual([])
    expect(await db.select().from(projections)).toEqual(checkpoint)
    await runner.catchUp(progressProjection)
    expect(await participants()).toEqual([])
    expect(await rows()).toEqual([adventurer('alice'), adventurer('bob')])
  })

  it('restores active membership and Builder progress if reconstruction fails after completion', async () => {
    await store.append(villageChannel('alice'), 0, [upgraded()])
    await store.append(gameChannel('g1'), 0, [created('bob')])
    await runner.catchUp(progressProjection)
    const before = await rows()
    const active = await participants()
    const checkpoint = await db.select().from(projections)
    await store.append(gameChannel('g1'), 1, [ended('lost', ['bob'])])
    const failing: Projection = {
      ...progressProjection,
      async apply(event, tx) {
        await progressProjection.apply(event, tx)
        if (event.type === 'GameEnded') throw new Error('Interrupted Dungeon reconstruction')
      },
    }
    await expect(runner.rebuild(failing)).rejects.toThrow('Interrupted Dungeon reconstruction')
    expect(await rows()).toEqual(before)
    expect(await participants()).toEqual(active)
    expect(await db.select().from(projections)).toEqual(checkpoint)

    await runner.rebuild(progressProjection)
    expect(await rows()).toEqual([progress('alice'), adventurer('bob')])
    expect(await participants()).toEqual([])
  })
})
