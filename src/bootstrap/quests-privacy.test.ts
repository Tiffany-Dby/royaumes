import { asc, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { gameChannel } from '@/modules/dungeon/contracts'
import { offerStream } from '@/modules/market/contracts'
import { createQuestsModule } from '@/modules/quests'
import { claimStream } from '@/modules/quests/contracts'
import { progressProjection } from '@/modules/quests/infrastructure/progress-projection'
import {
  dailyProgress,
  gamePlayers,
  tradeParticipants,
} from '@/modules/quests/infrastructure/schema'
import { villageChannel } from '@/modules/realm/contracts'
import { session, user } from '@/platform/auth/schema'
import { createEventStore } from '@/platform/event-store/event-store'
import { outbox } from '@/platform/outbox/schema'
import { ERASED_NAME, ERASED_VILLAGE } from '@/platform/privacy/privacy'
import { createProjectionRunner } from '@/platform/projection/projection'
import { createTestApi, TEST_CRON_SECRET } from './testing'

type TestApi = Awaited<ReturnType<typeof createTestApi>>

async function foundAndUpgrade(api: TestApi, playerId: string) {
  expect(
    (await api.post('/api/realm/village', { name: `${playerId}'s private village` }, playerId))
      .status,
  ).toBe(201)
  expect(
    (await api.post('/api/realm/village/upgrade', { building: 'sawmill' }, playerId)).status,
  ).toBe(200)
}

async function exportSections(api: TestApi, playerId = 'alice') {
  const response = await api.get('/api/account/export', playerId)
  expect(response.status).toBe(200)
  return (await response.json()).sections
}

async function openDungeon(api: TestApi, host = 'alice', members: string[] = []) {
  const response = await api.post('/api/dungeon/games', {}, host)
  expect(response.status).toBe(201)
  const { gameId } = await response.json()
  for (const member of members) {
    expect((await api.post(`/api/dungeon/games/${gameId}/join`, {}, member)).status).toBe(200)
  }
  return gameId as string
}

/** Append the published completion payload without depending on randomized combat outcomes. */
async function completeDungeon(api: TestApi, gameId: string, heroIds: string[]) {
  const store = createEventStore(api.db)
  const history = await store.read(gameChannel(gameId))
  await store.append(gameChannel(gameId), history.at(-1)?.version ?? 0, [
    {
      type: 'GameEnded',
      data: { result: 'lost', loot: 0, heroIds, at: Date.UTC(2026, 0, 1) },
    },
  ])
}

async function marketWithVillages() {
  const api = await createTestApi()
  for (const player of ['alice', 'bob', 'carol']) {
    expect(
      (await api.post('/api/realm/village', { name: `${player}'s private village` }, player))
        .status,
    ).toBe(201)
  }
  return api
}

async function publishMarket(
  api: TestApi,
  seller = 'alice',
  give = { wood: 10 },
  want = { stone: 5 },
) {
  const response = await api.post('/api/market/offers', { give, want }, seller)
  expect(response.status).toBe(201)
  return response.json() as Promise<{ offerId: string; view: { status: string } }>
}

/** Record the published acceptance payload without settling payment to inspect pending attribution. */
async function recordAcceptance(api: TestApi, offerId: string, buyerId: string) {
  const store = createEventStore(api.db)
  const history = await store.read(offerStream(offerId))
  await store.append(offerStream(offerId), history.at(-1)?.version ?? 0, [
    {
      type: 'OfferAccepted',
      data: { buyerId, buyerName: buyerId, attempt: 1, at: Date.UTC(2026, 0, 1) },
    },
  ])
}

describe('Merchant progress and personal data integration', () => {
  it.each([1, 2])(
    'credits Alice and Carol after %s real failed payments by Bob',
    async (attempts) => {
      const api = await marketWithVillages()
      // Reserving Bob's stone makes his payment fail while Carol still has enough.
      const reserved = await api.post(
        '/api/market/offers',
        { give: { stone: 40 }, want: { wood: 10 } },
        'bob',
      )
      expect(reserved.status).toBe(201)
      const bobOffer = await reserved.json()
      expect(bobOffer.view.status).toBe('open')
      const { offerId } = await publishMarket(api, 'alice', { wood: 60 }, { stone: 30 })
      for (let i = 0; i < attempts; i++) {
        const response = await api.post(`/api/market/offers/${offerId}/accept`, {}, 'bob')
        expect(response.status).toBe(200)
        expect((await response.json()).view).toMatchObject({
          status: 'open',
          missing: { stone: 20 },
        })
        expect((await exportSections(api)).quests.progress).toEqual([])
        expect((await exportSections(api, 'bob')).quests.marketParticipations).toEqual([
          { offerId: bobOffer.offerId, role: 'seller' },
        ])
        expect(
          await api.db
            .select()
            .from(tradeParticipants)
            .where(eq(tradeParticipants.offerId, offerId)),
        ).toEqual([{ offerId, sellerId: 'alice', buyerId: null }])
      }
      expect(
        (await api.post(`/api/market/offers/${bobOffer.offerId}/withdraw`, {}, 'bob')).status,
      ).toBe(200)
      const success = await api.post(`/api/market/offers/${offerId}/accept`, {}, 'carol')
      expect(success.status).toBe(200)
      expect((await success.json()).view.status).toBe('completed')
      for (const player of ['alice', 'carol']) {
        expect((await exportSections(api, player)).quests).toEqual({
          villageExists: true,
          claims: [],
          progress: [{ day: '2026-01-01', questId: 'merchant', count: 1 }],
          dungeonParticipations: [],
          marketParticipations: [],
        })
      }
      expect((await exportSections(api, 'bob')).quests).toEqual({
        villageExists: true,
        claims: [],
        progress: [],
        dungeonParticipations: [],
        marketParticipations: [],
      })
      const events = await createEventStore(api.db).read(offerStream(offerId))
      expect(events.filter((event) => event.type === 'PaymentRefused')).toHaveLength(attempts)
      expect(events.filter((event) => event.type === 'TradeCompleted')).toHaveLength(1)
    },
  )

  it.each(['rejected', 'withdrawn', 'expired'])(
    'cleans up a real %s offer without progress',
    async (outcome) => {
      const api = await marketWithVillages()
      const { offerId, view } = await publishMarket(api, 'alice', {
        wood: outcome === 'rejected' ? 500 : 10,
      })
      if (outcome === 'rejected') expect(view.status).toBe('rejected')
      else if (outcome === 'withdrawn') {
        expect((await api.post(`/api/market/offers/${offerId}/withdraw`, {})).status).toBe(200)
      } else {
        api.advance(24 * 60)
        expect((await api.get('/api/market/offers')).status).toBe(200)
      }
      expect((await exportSections(api)).quests).toEqual({
        villageExists: true,
        claims: [],
        progress: [],
        dungeonParticipations: [],
        marketParticipations: [],
      })
      expect(await api.db.select().from(tradeParticipants)).toEqual([])
    },
  )

  it("exports only the requesting participant's role without the counterparty or resource amounts", async () => {
    const api = await marketWithVillages()
    const shared = await publishMarket(api)
    const unrelated = await publishMarket(api, 'carol')
    await recordAcceptance(api, shared.offerId, 'bob')
    for (const [player, role] of [
      ['alice', 'seller'],
      ['bob', 'buyer'],
    ] as const) {
      const quests = (await exportSections(api, player)).quests
      expect(quests).toEqual({
        villageExists: true,
        claims: [],
        progress: [],
        dungeonParticipations: [],
        marketParticipations: [{ offerId: shared.offerId, role }],
      })
      expect(JSON.stringify(quests)).not.toContain('buyerId')
      expect(JSON.stringify(quests)).not.toContain('sellerId')
      expect(JSON.stringify(quests)).not.toContain('wood')
      expect(JSON.stringify(quests)).not.toContain('private village')
    }
    expect((await exportSections(api, 'carol')).quests.marketParticipations).toEqual([
      { offerId: unrelated.offerId, role: 'seller' },
    ])
  })

  it.each([false, true])(
    'rebuilds pseudonymous Market progress and pending roles after deletion (projected before deletion: %s)',
    async (projectedBeforeDeletion) => {
      const api = await marketWithVillages()
      await api.db.insert(user).values([
        { id: 'alice', name: 'Alice Private', email: 'alice@example.test' },
        { id: 'bob', name: 'Bob Private', email: 'bob@example.test' },
        { id: 'carol', name: 'Carol Private', email: 'carol@example.test' },
      ])
      const completed = await publishMarket(api)
      const success = await api.post(`/api/market/offers/${completed.offerId}/accept`, {}, 'carol')
      expect(success.status).toBe(200)
      expect((await success.json()).view.status).toBe('completed')
      const pending = await publishMarket(api, 'bob')
      await recordAcceptance(api, pending.offerId, 'alice')
      if (projectedBeforeDeletion) await exportSections(api)
      const response = await api.api.request('/api/account', {
        method: 'DELETE',
        headers: { 'x-test-user': 'alice' },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ eventsRewritten: 3 })
      const runner = createProjectionRunner(api.db)
      await runner.catchUp(progressProjection)
      const retainedProgress = await api.db
        .select()
        .from(dailyProgress)
        .orderBy(asc(dailyProgress.playerId))
      const retainedTrades = await api.db.select().from(tradeParticipants)
      expect(retainedProgress).toEqual([
        { playerId: 'alice', day: '2026-01-01', questId: 'merchant', count: 1 },
        { playerId: 'carol', day: '2026-01-01', questId: 'merchant', count: 1 },
      ])
      expect(retainedTrades).toEqual([
        { offerId: pending.offerId, sellerId: 'bob', buyerId: 'alice' },
      ])
      await runner.rebuild(progressProjection)
      expect(
        await api.db.select().from(dailyProgress).orderBy(asc(dailyProgress.playerId)),
      ).toEqual(retainedProgress)
      expect(await api.db.select().from(tradeParticipants)).toEqual(retainedTrades)
      expect(await api.db.select().from(user).where(eq(user.id, 'alice'))).toEqual([])
      expect(await api.db.select().from(user).where(eq(user.id, 'bob'))).toHaveLength(1)
      const store = createEventStore(api.db)
      expect((await store.read(offerStream(completed.offerId)))[0].data.sellerName).toBe(
        ERASED_NAME,
      )
      expect(
        (await store.read(offerStream(pending.offerId))).find(
          (event) => event.type === 'OfferAccepted',
        )?.data.buyerName,
      ).toBe(ERASED_NAME)
      expect((await exportSections(api, 'bob')).quests).toEqual({
        villageExists: true,
        claims: [],
        progress: [],
        dungeonParticipations: [],
        marketParticipations: [{ offerId: pending.offerId, role: 'seller' }],
      })
      expect(await runner.catchUp(progressProjection)).toBe(0)
    },
  )
})

describe('Quests personal data integration', () => {
  it('isolates claim exports and settles retained pending rewards after deletion and reconstruction', async () => {
    const api = await createTestApi()
    await api.db.insert(user).values([
      { id: 'alice', name: 'Alice Private', email: 'alice@example.test' },
      { id: 'bob', name: 'Bob Private', email: 'bob@example.test' },
    ])
    for (const player of ['alice', 'bob']) {
      await foundAndUpgrade(api, player)
    }
    api.advance(60)
    for (const player of ['alice', 'bob']) {
      expect(
        (await api.post('/api/realm/village/upgrade', { building: 'quarry' }, player)).status,
      ).toBe(200)
    }
    const store = createEventStore(api.db)
    const runner = createProjectionRunner(api.db)
    const module = createQuestsModule({
      db: api.db,
      store,
      projections: runner,
      clock: () => Date.UTC(2026, 0, 1, 1),
      dispatch: async () => {},
    })
    const result = await module.claims.claim('alice', 'builder')
    if (!result.ok) throw new Error(result.error.code)
    const pending = (await exportSections(api)).quests
    expect(pending.villageExists).toBe(true)
    expect(pending.claims).toEqual([
      {
        day: '2026-01-01',
        questId: 'builder',
        reward: { resource: 'wood', amount: 50 },
        acceptedAt: Date.UTC(2026, 0, 1, 1),
        transferId: result.claim.transferId,
        deliveredAt: null,
      },
    ])
    expect((await exportSections(api, 'bob')).quests.claims).toEqual([])
    expect(JSON.stringify(pending)).not.toContain('Alice Private')
    const messages = await api.db.select().from(outbox)
    const erased = await api.api.request('/api/account', {
      method: 'DELETE',
      headers: { 'x-test-user': 'alice' },
    })
    expect(erased.status).toBe(200)
    await runner.rebuild(progressProjection)
    expect((await exportSections(api)).quests).toEqual(pending)
    expect(await api.db.select().from(outbox)).toEqual(messages)
    expect(await api.db.select().from(user).where(eq(user.id, 'alice'))).toEqual([])
    api.advance(24 * 60)
    const dispatched = await api.api.request('/api/cron/daily', {
      headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
    })
    expect(dispatched.status).toBe(200)
    const history = await store.read(claimStream(result.claim))
    expect(history.map((event) => event.type)).toEqual([
      'QuestRewardClaimAccepted',
      'QuestRewardDelivered',
    ])
    const delivered = (await exportSections(api)).quests.claims
    expect(delivered).toEqual([{ ...pending.claims[0], deliveredAt: Date.UTC(2026, 0, 2, 1) }])
    const village = await store.read(villageChannel('alice'))
    expect(
      village.filter(
        (event) =>
          event.type === 'ResourcesDeposited' && event.data.transferId === result.claim.transferId,
      ),
    ).toHaveLength(1)
    await runner.rebuild(progressProjection)
    expect((await exportSections(api)).quests.claims).toEqual(delivered)
  })
  it('exports an empty progress list when the player has no progress', async () => {
    const api = await createTestApi()
    expect((await exportSections(api)).quests).toEqual({
      villageExists: false,
      claims: [],
      progress: [],
      dungeonParticipations: [],
      marketParticipations: [],
    })
  })

  it('catches up and exports only the requested player across all recorded days', async () => {
    const api = await createTestApi()
    await foundAndUpgrade(api, 'alice')
    await foundAndUpgrade(api, 'bob')
    api.advance(24 * 60)
    expect(
      (await api.post('/api/realm/village/upgrade', { building: 'quarry' }, 'alice')).status,
    ).toBe(200)

    const alice = (await exportSections(api)).quests
    expect(alice).toEqual({
      villageExists: true,
      claims: [],
      progress: [
        { day: '2026-01-01', questId: 'builder', count: 1 },
        { day: '2026-01-02', questId: 'builder', count: 1 },
      ],
      dungeonParticipations: [],
      marketParticipations: [],
    })
    expect((await exportSections(api, 'bob')).quests).toEqual({
      villageExists: true,
      claims: [],
      progress: [{ day: '2026-01-01', questId: 'builder', count: 1 }],
      dungeonParticipations: [],
      marketParticipations: [],
    })
    expect((await exportSections(api, 'carol')).quests).toEqual({
      villageExists: false,
      claims: [],
      progress: [],
      dungeonParticipations: [],
      marketParticipations: [],
    })
    expect(JSON.stringify(alice)).not.toContain('bob')
    expect(JSON.stringify(alice)).not.toContain('private village')
  })

  it('preserves the existing contributors while adding Quests to account export', async () => {
    const api = await createTestApi()
    await foundAndUpgrade(api, 'alice')
    api.advance(60)
    const gameResponse = await api.post('/api/dungeon/games', {})
    expect(gameResponse.status).toBe(201)
    const { gameId } = await gameResponse.json()
    const offerResponse = await api.post('/api/market/offers', {
      give: { wood: 10 },
      want: { stone: 5 },
    })
    expect(offerResponse.status).toBe(201)
    const { offerId } = await offerResponse.json()
    expect((await api.post('/api/tavern/messages', { body: 'A private message' })).status).toBe(201)

    const sections = await exportSections(api)
    expect(Object.keys(sections).sort()).toEqual([
      'dungeon',
      'identity',
      'market',
      'quests',
      'ranking',
      'realm',
      'tavern',
    ])
    expect(sections.realm).toMatchObject({ village: "alice's private village" })
    expect(sections.dungeon.expeditions).toMatchObject([{ gameId, role: 'host' }])
    expect(sections.market.published).toMatchObject([{ give: { wood: 10 }, want: { stone: 5 } }])
    expect(sections.ranking).toMatchObject({ playerId: 'alice', upgrades: 1 })
    expect(sections.tavern.messages).toMatchObject([{ body: 'A private message' }])
    expect(sections.identity).toEqual({ account: null, sessions: [] })
    expect(sections.quests).toEqual({
      villageExists: true,
      claims: [],
      progress: [{ day: '2026-01-01', questId: 'builder', count: 1 }],
      dungeonParticipations: [{ gameId }],
      marketParticipations: [{ offerId, role: 'seller' }],
    })
  })

  it.each([false, true])(
    'retains only pseudonymous progress after deletion and rebuild (projected before deletion: %s)',
    async (projectedBeforeDeletion) => {
      const api = await createTestApi()
      await api.db.insert(user).values([
        { id: 'alice', name: 'Alice Private', email: 'alice@example.test' },
        { id: 'bob', name: 'Bob Private', email: 'bob@example.test' },
      ])
      await api.db.insert(session).values(
        ['alice', 'bob'].map((playerId) => ({
          id: `session-${playerId}`,
          userId: playerId,
          token: `secret-${playerId}`,
          expiresAt: new Date(Date.UTC(2027, 0, 1)),
        })),
      )
      await foundAndUpgrade(api, 'alice')
      await foundAndUpgrade(api, 'bob')
      if (projectedBeforeDeletion) await exportSections(api)

      const response = await api.api.request('/api/account', {
        method: 'DELETE',
        headers: { 'x-test-user': 'alice' },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ eventsRewritten: 1 })

      const runner = createProjectionRunner(api.db)
      await runner.catchUp(progressProjection)
      const retained = await api.db
        .select()
        .from(dailyProgress)
        .orderBy(asc(dailyProgress.playerId))
      expect(retained).toEqual([
        { playerId: 'alice', day: '2026-01-01', questId: 'builder', count: 1 },
        { playerId: 'bob', day: '2026-01-01', questId: 'builder', count: 1 },
      ])

      await runner.rebuild(progressProjection)
      expect(
        await api.db.select().from(dailyProgress).orderBy(asc(dailyProgress.playerId)),
      ).toEqual(retained)
      expect(await api.db.select().from(user).where(eq(user.id, 'alice'))).toEqual([])
      expect(await api.db.select().from(session).where(eq(session.userId, 'alice'))).toEqual([])
      expect(await api.db.select().from(user).where(eq(user.id, 'bob'))).toHaveLength(1)
      expect(await api.db.select().from(session).where(eq(session.userId, 'bob'))).toHaveLength(1)

      const store = createEventStore(api.db)
      expect((await store.read(villageChannel('alice')))[0].data.name).toBe(ERASED_VILLAGE)
      expect((await store.read(villageChannel('bob')))[0].data.name).toBe("bob's private village")
      expect(await runner.catchUp(progressProjection)).toBe(0)
    },
  )

  it("exports only the requesting human player's outstanding Dungeon participation", async () => {
    const api = await createTestApi()
    const shared = await openDungeon(api, 'alice', ['bob'])
    expect((await api.post(`/api/dungeon/games/${shared}/companion`, {}, 'alice')).status).toBe(200)
    const bobOnly = await openDungeon(api, 'bob')
    const carolOnly = await openDungeon(api, 'carol')
    const alice = (await exportSections(api)).quests
    expect(alice).toEqual({
      villageExists: false,
      claims: [],
      progress: [],
      dungeonParticipations: [{ gameId: shared }],
      marketParticipations: [],
    })
    expect((await exportSections(api, 'bob')).quests).toEqual({
      villageExists: false,
      claims: [],
      progress: [],
      dungeonParticipations: [shared, bobOnly].sort().map((gameId) => ({ gameId })),
      marketParticipations: [],
    })
    expect((await exportSections(api, 'carol')).quests).toEqual({
      villageExists: false,
      claims: [],
      progress: [],
      dungeonParticipations: [{ gameId: carolOnly }],
      marketParticipations: [],
    })
    expect((await exportSections(api, 'companion-1')).quests).toEqual({
      villageExists: false,
      claims: [],
      progress: [],
      dungeonParticipations: [],
      marketParticipations: [],
    })
    expect(JSON.stringify(alice)).not.toContain('bob')
    expect(JSON.stringify(alice)).not.toContain('seed')
    expect(JSON.stringify(alice)).not.toContain('hero')
  })

  it('exports completed Adventurer progress and removes outstanding participation', async () => {
    const api = await createTestApi()
    const gameId = await openDungeon(api, 'alice', ['bob'])
    await exportSections(api)
    await completeDungeon(api, gameId, ['alice', 'bob'])
    for (const playerId of ['alice', 'bob']) {
      expect((await exportSections(api, playerId)).quests).toEqual({
        villageExists: false,
        claims: [],
        progress: [{ day: '2026-01-01', questId: 'adventurer', count: 1 }],
        dungeonParticipations: [],
        marketParticipations: [],
      })
    }
  })

  it.each([false, true])(
    'rebuilds name-free Dungeon progress and membership after account deletion (projected before deletion: %s)',
    async (projectedBeforeDeletion) => {
      const api = await createTestApi()
      await api.db.insert(user).values([
        { id: 'alice', name: 'Alice Private', email: 'alice@example.test' },
        { id: 'bob', name: 'Bob Private', email: 'bob@example.test' },
      ])
      await foundAndUpgrade(api, 'alice')
      const active = await openDungeon(api, 'alice', ['bob'])
      const completed = await openDungeon(api, 'bob', ['alice'])
      await completeDungeon(api, completed, ['bob', 'alice'])
      if (projectedBeforeDeletion) await exportSections(api)

      const response = await api.api.request('/api/account', {
        method: 'DELETE',
        headers: { 'x-test-user': 'alice' },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ eventsRewritten: 3 })
      const runner = createProjectionRunner(api.db)
      await runner.catchUp(progressProjection)
      const retainedProgress = await api.db
        .select()
        .from(dailyProgress)
        .orderBy(asc(dailyProgress.playerId), asc(dailyProgress.questId))
      const retainedMembership = await api.db
        .select()
        .from(gamePlayers)
        .orderBy(asc(gamePlayers.gameId), asc(gamePlayers.playerId))
      expect(retainedProgress).toEqual([
        { playerId: 'alice', day: '2026-01-01', questId: 'adventurer', count: 1 },
        { playerId: 'alice', day: '2026-01-01', questId: 'builder', count: 1 },
        { playerId: 'bob', day: '2026-01-01', questId: 'adventurer', count: 1 },
      ])
      expect(retainedMembership).toEqual([
        { gameId: active, playerId: 'alice' },
        { gameId: active, playerId: 'bob' },
      ])
      await runner.rebuild(progressProjection)
      expect(
        await api.db
          .select()
          .from(dailyProgress)
          .orderBy(asc(dailyProgress.playerId), asc(dailyProgress.questId)),
      ).toEqual(retainedProgress)
      expect(
        await api.db
          .select()
          .from(gamePlayers)
          .orderBy(asc(gamePlayers.gameId), asc(gamePlayers.playerId)),
      ).toEqual(retainedMembership)
      expect(await api.db.select().from(user).where(eq(user.id, 'alice'))).toEqual([])
      expect(await api.db.select().from(user).where(eq(user.id, 'bob'))).toHaveLength(1)
      const store = createEventStore(api.db)
      expect((await store.read(gameChannel(active)))[0].data.hostName).toBe(ERASED_NAME)
      const joinedEvent = (await store.read(gameChannel(completed))).find(
        (event) => event.type === 'PlayerJoined',
      )
      expect(joinedEvent?.data.name).toBe(ERASED_NAME)
      expect(await runner.catchUp(progressProjection)).toBe(0)
    },
  )

  it('refuses an incomplete Quests export at a journal gap and succeeds after catch-up', async () => {
    const api = await createTestApi()
    const now = Date.now()
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(now)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = createEventStore(api.db)
      await store.append('export-gap', 0, [{ type: 'UnrelatedEvent', data: {} }])
      await expect(
        store.append('export-gap', 0, [{ type: 'UnrelatedEvent', data: {} }]),
      ).rejects.toMatchObject({ name: 'ConcurrencyError' })
      await foundAndUpgrade(api, 'alice')

      const response = await api.get('/api/account/export')
      expect(response.status).toBe(500)
      expect(response.headers.get('Content-Disposition')).toBeNull()
      expect(await response.json()).toEqual({
        error: { code: 'INTERNAL', message: 'Erreur interne' },
      })

      wallClock.mockReturnValue(now + 10_000)
      expect((await exportSections(api)).quests).toEqual({
        villageExists: true,
        claims: [],
        progress: [{ day: '2026-01-01', questId: 'builder', count: 1 }],
        dungeonParticipations: [],
        marketParticipations: [],
      })
    } finally {
      vi.restoreAllMocks()
    }
  })
})
