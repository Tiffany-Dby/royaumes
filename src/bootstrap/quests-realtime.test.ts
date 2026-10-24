import { beforeEach, describe, expect, it, vi } from 'vitest'
import { gameChannel } from '@/modules/dungeon/contracts'
import { offerStream } from '@/modules/market/contracts'
import { claimStream, claimTransferId, QUESTS_CHANNEL } from '@/modules/quests/contracts'
import { questDayAt } from '@/modules/quests/domain/quest-day'
import { createQuestsChannel } from '@/modules/quests/infrastructure/quests-channel'
import { villageChannel } from '@/modules/realm/contracts'
import {
  createEventStore,
  type EventStore,
  type NewEvent,
} from '@/platform/event-store/event-store'
import { createTestApi } from './testing'

const at = Date.UTC(2026, 0, 1)
const upgraded: NewEvent = {
  type: 'BuildingUpgraded',
  data: { building: 'sawmill', toLevel: 2, cost: { wood: 98, stone: 49 }, at },
}
const created: NewEvent = {
  type: 'GameCreated',
  data: {
    hostId: 'alice',
    hostName: 'Alice',
    hero: { hp: 30, attack: 6 },
    seed: 42,
    difficulty: 'easy',
    at,
  },
}
const completed: NewEvent = { type: 'TradeCompleted', data: { at } }

let api: Awaited<ReturnType<typeof createTestApi>>
let store: EventStore
beforeEach(async () => {
  api = await createTestApi()
  store = createEventStore(api.db)
})

async function notifications(player: string, after = 0) {
  const response = await api.get(`/api/stream/${QUESTS_CHANNEL}/events?after=${after}`, player)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  return (await response.json()).events
}

function notice(position: number) {
  return { position, stream: QUESTS_CHANNEL, version: position, type: 'QuestsChanged', data: {} }
}

function frames(body: string) {
  return body
    .split('\n\n')
    .filter((frame) => frame.includes('event: domain-event'))
    .map((frame) => JSON.parse(frame.match(/^data: (.+)$/m)?.[1] ?? 'null'))
}

describe('Private Quests realtime channel', () => {
  it('requires authentication and does not allow selecting another player', async () => {
    for (const suffix of ['', '/events']) {
      expect((await api.get(`/api/stream/${QUESTS_CHANNEL}${suffix}`, null)).status).toBe(401)
      expect((await api.get(`/api/stream/${QUESTS_CHANNEL}-bob${suffix}`)).status).toBe(403)
    }
    await store.append(villageChannel('bob'), 0, [upgraded])
    const response = await api.get(`/api/stream/${QUESTS_CHANNEL}/events?after=0&userId=bob`)
    expect(await response.json()).toEqual({ events: [] })
  })

  it('isolates concurrent subscribers and sanitizes Village events on the fallback route', async () => {
    const [founded, upgrade] = await store.append(villageChannel('alice'), 0, [
      { type: 'VillageFounded', data: { name: 'Private Village', at } },
      upgraded,
    ])
    const [bob] = await store.append(villageChannel('bob'), 0, [upgraded])
    await store.append('unexpected-alice', 0, [upgraded])
    await store.append(villageChannel('alice'), 2, [{ type: 'ResourcesDeposited', data: {} }])

    expect(await Promise.all([notifications('alice'), notifications('bob')])).toEqual([
      [notice(founded.position), notice(upgrade.position)],
      [notice(bob.position)],
    ])
  })

  it('notifies human Dungeon members only when their expedition ends', async () => {
    await store.append(gameChannel('private-game'), 0, [
      created,
      {
        type: 'PlayerJoined',
        data: { playerId: 'bob', name: 'Bob', hero: { hp: 30, attack: 6 }, at },
      },
      {
        type: 'CompanionAdded',
        data: { companionId: 'companion-1', name: 'AI', hero: { hp: 30, attack: 6 }, at },
      },
    ])
    expect(await notifications('alice')).toEqual([])
    const [ended] = await store.append(gameChannel('private-game'), 3, [
      {
        type: 'GameEnded',
        data: { result: 'lost', loot: 0, heroIds: ['alice', 'bob', 'companion-1'], at },
      },
    ])
    expect(await notifications('alice')).toEqual([notice(ended.position)])
    expect(await notifications('bob')).toEqual([notice(ended.position)])
    expect(await notifications('companion-1')).toEqual([])
    expect(await notifications('carol')).toEqual([])
  })

  it('notifies the seller and successful buyer rather than a refused buyer', async () => {
    const events = await store.append(offerStream('private-offer'), 0, [
      {
        type: 'OfferPublished',
        data: {
          offerId: 'private-offer',
          sellerId: 'alice',
          sellerName: 'Alice',
          give: { wood: 10 },
          want: { gold: 5 },
          expiresAt: at + 60_000,
          at,
        },
      },
      { type: 'OfferOpened', data: { at } },
      { type: 'OfferAccepted', data: { buyerId: 'bob', attempt: 1, at } },
      { type: 'PaymentRefused', data: { buyerId: 'bob', missing: { gold: 5 }, at } },
      { type: 'OfferAccepted', data: { buyerId: 'carol', attempt: 2, at } },
      completed,
    ])
    const last = events[events.length - 1]
    expect(await notifications('alice')).toEqual([notice(last.position)])
    expect(await notifications('carol')).toEqual([notice(last.position)])
    expect(await notifications('bob')).toEqual([])
  })

  it('notifies only the owner of accepted and delivered claims with an exact identity boundary', async () => {
    const key = { playerId: 'alice', day: questDayAt(at), questId: 'builder' } as const
    const [accepted, delivered] = await store.append(claimStream(key), 0, [
      {
        type: 'QuestRewardClaimAccepted',
        data: {
          ...key,
          reward: { resource: 'wood', amount: 50 },
          acceptedAt: at,
          transferId: claimTransferId(key),
        },
      },
      { type: 'QuestRewardDelivered', data: { transferId: claimTransferId(key), at } },
    ])
    await store.append(claimStream({ ...key, playerId: 'alice-other' }), 0, [
      { type: 'QuestRewardDelivered', data: { transferId: 'private-transfer', at } },
    ])
    expect(await notifications('alice')).toEqual([
      notice(accepted.position),
      notice(delivered.position),
    ])
    expect(await notifications('bob')).toEqual([])
  })

  it('resumes SSE across unrelated events and never transmits original event metadata', async () => {
    const [first] = await store.append(villageChannel('alice'), 0, [upgraded])
    await store.append(villageChannel('bob'), 0, [upgraded])
    await store.append('unrelated', 0, [{ type: 'OtherEvent', data: { secret: 'hidden' } }])
    const [next] = await store.append(villageChannel('alice'), 1, [upgraded])
    const response = await api.api.request(`/api/stream/${QUESTS_CHANNEL}`, {
      headers: { 'x-test-user': 'alice', 'last-event-id': String(first.position) },
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain(`id: ${next.position}\n`)
    expect(frames(body)).toEqual([notice(next.position)])
  })

  it('starts at the current cursor and delivers subsequent live events', async () => {
    await store.append(villageChannel('alice'), 0, [upgraded])
    const response = await api.get(`/api/stream/${QUESTS_CHANNEL}`)
    if (!response.body) throw new Error('Expected an SSE response body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let body = decoder.decode((await reader.read()).value)
    expect(body).toContain('event: ready')
    const [live] = await store.append(villageChannel('alice'), 1, [upgraded])
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      body += decoder.decode(chunk.value)
    }
    expect(frames(body)).toEqual([notice(live.position)])
  })

  it('advances over irrelevant players and reads completion histories once per connection scan', async () => {
    await store.append(gameChannel('other-game'), 0, [
      { ...created, data: { ...created.data, hostId: 'bob' } },
      { type: 'GameEnded', data: { result: 'won', loot: 10, heroIds: ['bob'], at } },
    ])
    const [last] = await store.append(villageChannel('bob'), 0, [upgraded])
    const readAll = vi.spyOn(store, 'readAll')
    const read = vi.spyOn(store, 'read')
    const factory = createQuestsChannel(store).source
    if (typeof factory !== 'function') throw new Error('A subscriber needs its own source')
    const source = factory('alice')
    expect(await source.read(0)).toEqual([])
    expect(await source.read(0)).toEqual([])
    expect(readAll).toHaveBeenCalledTimes(1)

    const [ignored] = await store.append('unrelated', 0, [{ type: 'OtherEvent', data: {} }])
    expect(await source.read(0)).toEqual([])
    expect(readAll).toHaveBeenLastCalledWith({
      types: expect.arrayContaining(['GameEnded', 'TradeCompleted', 'QuestRewardDelivered']),
      afterPosition: last.position,
    })
    expect(read).toHaveBeenCalledExactlyOnceWith(gameChannel('other-game'))

    const [own] = await store.append(villageChannel('alice'), 0, [upgraded])
    expect((await source.read(0)).map((event) => event.position)).toEqual([own.position])
    expect(readAll).toHaveBeenLastCalledWith({
      types: expect.any(Array),
      afterPosition: ignored.position,
    })
    expect(read).toHaveBeenCalledTimes(1)
    expect((await factory('bob').read(0)).map((event) => event.position)).toHaveLength(2)
  })
})
