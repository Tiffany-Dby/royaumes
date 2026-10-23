import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DailyQuests } from '@/modules/quests/contracts'
import { QUESTS } from '@/modules/quests/domain/catalog'
import { dailyProgress } from '@/modules/quests/infrastructure/schema'
import { ConcurrencyError, createEventStore } from '@/platform/event-store/event-store'
import { createTestApi } from './testing'

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
