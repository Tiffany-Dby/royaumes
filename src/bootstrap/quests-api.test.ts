import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQuestsModule } from '@/modules/quests'
import { createQuestsApi } from '@/modules/quests/api'
import type { ClaimResult } from '@/modules/quests/application/claim-service'
import { claimStream, type DailyQuests } from '@/modules/quests/contracts'
import { QUESTS } from '@/modules/quests/domain/catalog'
import { questDayAt } from '@/modules/quests/domain/quest-day'
import { dailyProgress } from '@/modules/quests/infrastructure/schema'
import { villageChannel } from '@/modules/realm/contracts'
import { ConcurrencyError, createEventStore } from '@/platform/event-store/event-store'
import { requireUser } from '@/platform/http/require-user'
import type { AppEnv } from '@/platform/http/types'
import { outbox } from '@/platform/outbox/schema'
import { createProjectionRunner } from '@/platform/projection/projection'
import { createTestApi, testAuth } from './testing'

type TestApi = Awaited<ReturnType<typeof createTestApi>>

async function dailyQuests(api: TestApi, player = 'alice'): Promise<DailyQuests> {
  const response = await api.get('/api/quests', player)
  expect(response.status).toBe(200)
  return response.json()
}

async function foundVillage(api: TestApi, player = 'alice') {
  expect(
    (await api.post('/api/realm/village', { name: `${player}'s village` }, player)).status,
  ).toBe(201)
}

async function upgrade(api: TestApi) {
  expect((await api.post('/api/realm/village/upgrade', { building: 'sawmill' })).status).toBe(200)
}

afterEach(() => vi.restoreAllMocks())

async function completeBuilder(api: TestApi) {
  await foundVillage(api)
  api.advance(60)
  await upgrade(api)
  api.advance(60)
  await upgrade(api)
}

function authenticated(api: ReturnType<typeof createQuestsApi>) {
  return new Hono<AppEnv>().use('*', requireUser(testAuth)).route('/api/quests', api)
}

const claimRequest = {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-test-user': 'alice' },
  body: JSON.stringify({ day: '2026-01-01' }),
}

describe('Daily Quest claim API', () => {
  it('requires authentication before accepting claims', async () => {
    const api = await createTestApi()
    const response = await api.post('/api/quests/builder/claim', { day: '2026-01-01' }, null)
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('UNAUTHENTICATED')
  })

  it.each([{}, { day: '2026-02-30' }])('requires a valid displayed UTC day (%j)', async (body) => {
    const api = await createTestApi()
    const response = await api.post('/api/quests/builder/claim', body)
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('INVALID_INPUT')
  })

  it('rejects quest IDs outside the catalog', async () => {
    const api = await createTestApi()
    const response = await api.post('/api/quests/unknown/claim', { day: '2026-01-01' })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { code: 'QUEST_NOT_FOUND' } })
  })

  it('accepts only the session player and catalog reward, and rejects repeated requests', async () => {
    const api = await createTestApi()
    await completeBuilder(api)
    await foundVillage(api, 'bob')
    const forged = await api.post(
      '/api/quests/builder/claim',
      { day: '2026-01-01', playerId: 'alice' },
      'bob',
    )
    expect(forged.status).toBe(409)
    expect(await forged.json()).toEqual({ error: { code: 'QUEST_INCOMPLETE' } })
    const response = await api.post('/api/quests/builder/claim', {
      day: '2026-01-01',
      playerId: 'bob',
      reward: { resource: 'gold', amount: 999 },
    })
    expect(response.status).toBe(202)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toEqual({
      accepted: true,
      claim: { questId: 'builder', day: '2026-01-01', reward: { resource: 'wood', amount: 50 } },
    })
    const duplicate = await api.post('/api/quests/builder/claim', { day: '2026-01-01' })
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({ error: { code: 'ALREADY_CLAIMED' } })
    const store = createEventStore(api.db)
    const key = {
      playerId: 'alice',
      questId: 'builder' as const,
      day: questDayAt(Date.UTC(2026, 0, 1)),
    }
    expect((await store.read(claimStream(key))).map((event) => event.type)).toEqual([
      'QuestRewardClaimAccepted',
      'QuestRewardDelivered',
    ])
    expect(await store.read(claimStream({ ...key, playerId: 'bob' }))).toEqual([])
    expect(
      (await store.read(villageChannel('alice'))).filter(
        (event) => event.type === 'ResourcesDeposited',
      ),
    ).toHaveLength(1)
  })

  it('does not claim a completed new-day quest from a stale view', async () => {
    const api = await createTestApi()
    await completeBuilder(api)
    const previous = await dailyQuests(api)
    api.advance(24 * 60)
    await upgrade(api)
    await upgrade(api)
    const current = await dailyQuests(api)
    expect(current.day).toBe('2026-01-02')
    expect(current.quests[0].completed).toBe(true)
    const stale = await api.post('/api/quests/builder/claim', { day: previous.day })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: { code: 'NOT_CURRENT_DAY' } })
    const key = { playerId: 'alice', questId: 'builder' as const, day: current.day }
    expect(await createEventStore(api.db).read(claimStream(key))).toEqual([])
    expect((await api.post('/api/quests/builder/claim', { day: current.day })).status).toBe(202)
  })

  it.each([
    ['VILLAGE_REQUIRED', 409],
    ['QUEST_INCOMPLETE', 409],
    ['NOT_CURRENT_DAY', 409],
    ['QUESTS_NOT_READY', 503],
  ] as const)('maps %s to HTTP %s without dispatching', async (code, status) => {
    const result: ClaimResult = { ok: false, error: { code } }
    const claim = vi.fn(async () => result)
    const dispatch = vi.fn(async () => {})
    const api = authenticated(
      createQuestsApi({ get: vi.fn() }, { claim, confirm: vi.fn() }, dispatch),
    )
    const response = await api.request('/api/quests/builder/claim', claimRequest)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: { code } })
    expect(dispatch).not.toHaveBeenCalled()
    expect(claim).toHaveBeenCalledWith('alice', 'builder', questDayAt(Date.UTC(2026, 0, 1)))
  })

  it('keeps a durable acceptance successful when dispatch itself throws', async () => {
    const api = await createTestApi()
    await completeBuilder(api)
    const dispatch = vi.fn().mockRejectedValue(new Error('dispatcher unavailable'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createEventStore(api.db)
    const module = createQuestsModule({
      db: api.db,
      store,
      projections: createProjectionRunner(api.db),
      clock: () => Date.UTC(2026, 0, 1, 2),
      dispatch,
    })
    const response = await authenticated(module.api).request(
      '/api/quests/builder/claim',
      claimRequest,
    )
    expect(response.status).toBe(202)
    expect((await response.json()).accepted).toBe(true)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(logged).toHaveBeenCalled()
    expect(await dbPending(api)).toHaveLength(1)
    expect(
      (
        await store.read(
          claimStream({
            playerId: 'alice',
            day: questDayAt(Date.UTC(2026, 0, 1)),
            questId: 'builder',
          }),
        )
      ).map((event) => event.type),
    ).toEqual(['QuestRewardClaimAccepted'])
  })

  it('retains pending rewards during a Village outage and retries them on a later read', async () => {
    const api = await createTestApi({ villageService: true })
    await completeBuilder(api)
    api.setServiceUp(false)
    const response = await api.post('/api/quests/builder/claim', { day: '2026-01-01' })
    expect(response.status).toBe(202)
    expect((await response.json()).accepted).toBe(true)
    expect(await dbPending(api)).toHaveLength(1)
    api.setServiceUp(true)
    api.advance(1)
    expect((await api.get('/api/quests')).status).toBe(200)
    expect(await dbPending(api)).toEqual([])
    const history = await createEventStore(api.db).read(
      claimStream({ playerId: 'alice', questId: 'builder', day: questDayAt(Date.UTC(2026, 0, 1)) }),
    )
    expect(history.map((event) => event.type)).toEqual([
      'QuestRewardClaimAccepted',
      'QuestRewardDelivered',
    ])
  })
})

async function dbPending(api: TestApi) {
  return (await api.db.select().from(outbox)).filter((message) => message.processedAt === null)
}

describe('Daily Quests API', () => {
  it.each(['/api/quests', '/api/quests/'])('requires authentication for %s', async (path) => {
    const api = await createTestApi()
    const response = await api.get(path, null)
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('UNAUTHENTICATED')
  })

  it('returns the three catalog quests with zero progress without requiring a Village', async () => {
    const api = await createTestApi()
    const response = await api.get('/api/quests')
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toEqual({
      day: '2026-01-01',
      quests: QUESTS.map((quest) => ({ ...quest, progress: 0, completed: false })),
    })
  })

  it('catches up gameplay progress, derives completion and isolates players', async () => {
    const api = await createTestApi()
    await foundVillage(api)
    await foundVillage(api, 'bob')
    api.advance(60)
    await upgrade(api)
    expect((await dailyQuests(api)).quests[0]).toMatchObject({ progress: 1, completed: false })
    api.advance(60)
    await upgrade(api)

    const created = await api.post('/api/dungeon/games', {})
    expect(created.status).toBe(201)
    const { gameId } = await created.json()
    expect((await api.post(`/api/dungeon/games/${gameId}/start`, {})).status).toBe(200)
    api.advance(60)
    expect((await api.post(`/api/dungeon/games/${gameId}/deadline`, {})).status).toBe(200)

    const published = await api.post('/api/market/offers', {
      give: { wood: 10 },
      want: { stone: 5 },
    })
    expect(published.status).toBe(201)
    const { offerId } = await published.json()
    const accepted = await api.post(`/api/market/offers/${offerId}/accept`, {}, 'bob')
    expect(accepted.status).toBe(200)
    expect((await accepted.json()).view.status).toBe('completed')

    const alice = await dailyQuests(api)
    expect(alice).toEqual({
      day: '2026-01-01',
      quests: QUESTS.map((quest) => ({
        ...quest,
        progress: quest.requiredCount,
        completed: true,
      })),
    })
    expect(await dailyQuests(api)).toEqual(alice)
    const override = await api.get('/api/quests?playerId=alice&day=2025-12-31', 'bob')
    expect(override.status).toBe(200)
    expect(await override.json()).toEqual({
      day: '2026-01-01',
      quests: QUESTS.map((quest) => ({
        ...quest,
        progress: quest.id === 'merchant' ? 1 : 0,
        completed: quest.id === 'merchant',
      })),
    })
    expect((await dailyQuests(api, 'carol')).quests.every((quest) => quest.progress === 0)).toBe(
      true,
    )
  })

  it('selects the new UTC day at midnight and retains historical progress', async () => {
    const api = await createTestApi()
    await foundVillage(api)
    api.advance(24 * 60 - 1 / 60_000)
    await upgrade(api)
    expect(await dailyQuests(api)).toMatchObject({
      day: '2026-01-01',
      quests: [{ id: 'builder', progress: 1, completed: false }, {}, {}],
    })
    api.advance(1 / 60_000)
    expect(await dailyQuests(api)).toEqual({
      day: '2026-01-02',
      quests: QUESTS.map((quest) => ({ ...quest, progress: 0, completed: false })),
    })
    await upgrade(api)
    expect((await dailyQuests(api)).quests[0].progress).toBe(1)
    expect(
      await api.db.select().from(dailyProgress).where(eq(dailyProgress.playerId, 'alice')),
    ).toEqual(
      expect.arrayContaining([
        { playerId: 'alice', day: '2026-01-01', questId: 'builder', count: 1 },
        { playerId: 'alice', day: '2026-01-02', questId: 'builder', count: 1 },
      ]),
    )
  })

  it('returns a retryable response when catch-up is incomplete and succeeds on retry', async () => {
    const api = await createTestApi()
    const store = createEventStore(api.db)
    await store.append('gap-fixture', 0, [{ type: 'UnrelatedEvent', data: {} }])
    await expect(
      store.append('gap-fixture', 0, [{ type: 'UnrelatedEvent', data: {} }]),
    ).rejects.toBeInstanceOf(ConcurrencyError)
    await store.append('gap-fixture', 1, [{ type: 'UnrelatedEvent', data: {} }])

    const response = await api.get('/api/quests')
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'QUESTS_NOT_READY' } })

    // Advance only the runner's wall clock beyond its existing gap grace period.
    const later = Date.now() + 10_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    expect(await dailyQuests(api)).toEqual({
      day: '2026-01-01',
      quests: QUESTS.map((quest) => ({ ...quest, progress: 0, completed: false })),
    })
  })

  it('uses the existing sanitized error response when projection processing fails', async () => {
    const api = await createTestApi()
    await createEventStore(api.db).append('dungeon-invalid', 0, [
      { type: 'GameEnded', data: { result: 'lost', loot: 0, heroIds: [], at: 0 } },
    ])
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await api.get('/api/quests')
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: { code: 'INTERNAL', message: 'Erreur interne' },
    })
    expect(logged).toHaveBeenCalled()
  })
})
