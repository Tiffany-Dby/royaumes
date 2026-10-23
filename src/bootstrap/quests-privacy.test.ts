import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { gameChannel } from '@/modules/dungeon/contracts'
import { progressProjection } from '@/modules/quests/infrastructure/progress-projection'
import { dailyProgress, gamePlayers } from '@/modules/quests/infrastructure/schema'
import { villageChannel } from '@/modules/realm/contracts'
import { session, user } from '@/platform/auth/schema'
import { createEventStore } from '@/platform/event-store/event-store'
import { ERASED_NAME, ERASED_VILLAGE } from '@/platform/privacy/privacy'
import { createProjectionRunner } from '@/platform/projection/projection'
import { createTestApi } from './testing'

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

describe('Quests personal data integration', () => {
  it('exports an empty progress list when the player has no progress', async () => {
    const api = await createTestApi()
    expect((await exportSections(api)).quests).toEqual({ progress: [], dungeonParticipations: [] })
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
      progress: [
        { day: '2026-01-01', questId: 'builder', count: 1 },
        { day: '2026-01-02', questId: 'builder', count: 1 },
      ],
      dungeonParticipations: [],
    })
    expect((await exportSections(api, 'bob')).quests).toEqual({
      progress: [{ day: '2026-01-01', questId: 'builder', count: 1 }],
      dungeonParticipations: [],
    })
    expect((await exportSections(api, 'carol')).quests).toEqual({
      progress: [],
      dungeonParticipations: [],
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
    expect(
      (await api.post('/api/market/offers', { give: { wood: 10 }, want: { stone: 5 } })).status,
    ).toBe(201)
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
      progress: [{ day: '2026-01-01', questId: 'builder', count: 1 }],
      dungeonParticipations: [{ gameId }],
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
    expect(alice).toEqual({ progress: [], dungeonParticipations: [{ gameId: shared }] })
    expect((await exportSections(api, 'bob')).quests).toEqual({
      progress: [],
      dungeonParticipations: [shared, bobOnly].sort().map((gameId) => ({ gameId })),
    })
    expect((await exportSections(api, 'carol')).quests).toEqual({
      progress: [],
      dungeonParticipations: [{ gameId: carolOnly }],
    })
    expect((await exportSections(api, 'companion-1')).quests).toEqual({
      progress: [],
      dungeonParticipations: [],
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
        progress: [{ day: '2026-01-01', questId: 'adventurer', count: 1 }],
        dungeonParticipations: [],
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
})
