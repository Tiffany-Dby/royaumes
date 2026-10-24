import { describe, expect, it } from 'vitest'
import { QUESTS } from './catalog'
import { dungeonParticipant, marketBuyerAfter, progressCredit, questProgress } from './progress'

const MIDNIGHT = Date.UTC(2026, 9, 24)

describe('Quest progress decisions', () => {
  it('credits one Builder action to its player without changing the activity facts', () => {
    const activity = Object.freeze({
      type: 'BuildingUpgraded' as const,
      playerId: 'alice',
      at: MIDNIGHT - 1,
    })
    expect(progressCredit(activity)).toEqual({
      questId: 'builder',
      day: '2026-10-23',
      playerIds: ['alice'],
      count: 1,
    })
    expect(progressCredit(activity)).toEqual(progressCredit(activity))
    expect(activity).toEqual({ type: 'BuildingUpgraded', playerId: 'alice', at: MIDNIGHT - 1 })
  })

  it.each(['won', 'lost'] as const)(
    'credits human hosts and joiners after a %s expedition, excluding companions',
    (result) => {
      const players = [
        dungeonParticipant('GameCreated', { hostId: 'alice' }),
        dungeonParticipant('PlayerJoined', { playerId: 'companion-player' }),
        dungeonParticipant('CompanionAdded', { companionId: 'companion-1' }),
      ].filter((playerId) => playerId !== null)
      expect(players).toEqual(['alice', 'companion-player'])
      expect(
        progressCredit({ type: 'GameEnded', result, at: MIDNIGHT, humanPlayerIds: players }),
      ).toEqual({
        questId: 'adventurer',
        day: '2026-10-24',
        playerIds: players,
        count: 1,
      })
    },
  )

  it.each([
    [MIDNIGHT - 1, '2026-10-23'],
    [MIDNIGHT, '2026-10-24'],
  ])('assigns completion at %s to its gameplay UTC day', (at, day) => {
    expect(
      progressCredit({
        type: 'GameEnded',
        result: 'won',
        at,
        humanPlayerIds: ['alice', 'bob'],
      }).day,
    ).toBe(day)
    expect(
      progressCredit({ type: 'TradeCompleted', at, sellerId: 'alice', buyerId: 'bob' }).day,
    ).toBe(day)
  })

  it('rejects an expedition without recorded human participation', () => {
    expect(() =>
      progressCredit({
        type: 'GameEnded',
        result: 'won',
        at: MIDNIGHT,
        humanPlayerIds: [],
      }),
    ).toThrow('participation context')
  })

  it('credits only the seller and successful buyer after payment refusal and another acceptance', () => {
    const original = Object.freeze({ sellerId: 'alice', buyerId: null })
    const first = {
      ...original,
      buyerId: marketBuyerAfter(original, { type: 'OfferAccepted', buyerId: 'bob' }),
    }
    const refused = {
      ...first,
      buyerId: marketBuyerAfter(first, { type: 'PaymentRefused', buyerId: 'bob' }),
    }
    expect(refused.buyerId).toBeNull()
    expect(() => progressCredit({ type: 'TradeCompleted', ...refused, at: MIDNIGHT })).toThrow(
      'successful buyer',
    )
    const successful = {
      ...refused,
      buyerId: marketBuyerAfter(refused, { type: 'OfferAccepted', buyerId: 'carol' }),
    }
    expect(progressCredit({ type: 'TradeCompleted', ...successful, at: MIDNIGHT })).toEqual({
      questId: 'merchant',
      day: '2026-10-24',
      playerIds: ['alice', 'carol'],
      count: 1,
    })
    expect(original).toEqual({ sellerId: 'alice', buyerId: null })
  })

  it.each([
    {
      trade: { sellerId: 'alice', buyerId: null },
      change: { type: 'OfferAccepted', buyerId: 'alice' },
    },
    {
      trade: { sellerId: 'alice', buyerId: 'bob' },
      change: { type: 'OfferAccepted', buyerId: 'carol' },
    },
    {
      trade: { sellerId: 'alice', buyerId: 'bob' },
      change: { type: 'PaymentRefused', buyerId: 'carol' },
    },
  ] as const)(
    'rejects an inconsistent buyer transition ($change.type, $change.buyerId)',
    ({ trade, change }) => {
      expect(() => marketBuyerAfter(trade, change)).toThrow()
    },
  )

  it.each(QUESTS)('caps $id progress and completes it only at its catalog target', (quest) => {
    expect(questProgress(quest, quest.requiredCount - 1)).toEqual({
      progress: quest.requiredCount - 1,
      completed: false,
    })
    expect(questProgress(quest, quest.requiredCount)).toEqual({
      progress: quest.requiredCount,
      completed: true,
    })
    expect(questProgress(quest, quest.requiredCount + 1)).toEqual({
      progress: quest.requiredCount,
      completed: true,
    })
  })
})
