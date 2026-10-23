import { describe, expect, it } from 'vitest'
import { QUESTS } from './catalog'
import { type ClaimInput, decideClaim } from './claim'
import { questDayAt } from './quest-day'

const NOW = Date.UTC(2026, 9, 23, 12)
const MIDNIGHT = Date.UTC(2026, 9, 24)
const input: ClaimInput = {
  playerId: 'alice',
  questId: 'builder',
  day: questDayAt(NOW),
  progress: 2,
  villageExists: true,
  alreadyClaimed: false,
}

describe('Daily quest claim decisions', () => {
  it.each(QUESTS)('accepts a completed $id quest with its actual catalog reward', (quest) => {
    const decision = decideClaim(
      { ...input, questId: quest.id, progress: quest.requiredCount },
      NOW,
    )
    expect(decision).toEqual({
      ok: true,
      claim: {
        playerId: 'alice',
        questId: quest.id,
        day: input.day,
        reward: quest.reward,
        acceptedAt: NOW,
      },
    })
    if (!decision.ok) throw new Error(decision.error.code)
    expect(decision.claim.reward).not.toBe(quest.reward)
  })

  it.each(QUESTS)('rejects an incomplete $id quest', (quest) => {
    expect(
      decideClaim({ ...input, questId: quest.id, progress: quest.requiredCount - 1 }, NOW),
    ).toEqual({ ok: false, error: { code: 'QUEST_INCOMPLETE' } })
  })

  it('requires an existing Village', () => {
    expect(decideClaim({ ...input, villageExists: false }, NOW)).toEqual({
      ok: false,
      error: { code: 'VILLAGE_REQUIRED' },
    })
  })

  it('rejects a second claim for the same player, day and quest', () => {
    expect(decideClaim({ ...input, alreadyClaimed: true }, NOW)).toEqual({
      ok: false,
      error: { code: 'ALREADY_CLAIMED' },
    })
  })

  it.each([Date.UTC(2026, 9, 22), Date.UTC(2026, 9, 24)])(
    'rejects a quest outside the current UTC day (%s)',
    (timestamp) => {
      expect(decideClaim({ ...input, day: questDayAt(timestamp) }, NOW)).toEqual({
        ok: false,
        error: { code: 'NOT_CURRENT_DAY' },
      })
    },
  )

  it('accepts through the last millisecond of the quest day but rejects at midnight', () => {
    expect(decideClaim(input, MIDNIGHT - 1).ok).toBe(true)
    expect(decideClaim(input, MIDNIGHT)).toEqual({
      ok: false,
      error: { code: 'NOT_CURRENT_DAY' },
    })
    expect(decideClaim({ ...input, day: questDayAt(MIDNIGHT) }, MIDNIGHT).ok).toBe(true)
  })

  it('retains the accepted reward after midnight and refuses another acceptance', () => {
    const decision = decideClaim(input, MIDNIGHT - 1)
    if (!decision.ok) throw new Error(decision.error.code)
    expect(decideClaim({ ...input, alreadyClaimed: true }, MIDNIGHT)).toEqual({
      ok: false,
      error: { code: 'ALREADY_CLAIMED' },
    })
    expect(decision.claim).toEqual({
      playerId: 'alice',
      questId: 'builder',
      day: input.day,
      reward: { resource: 'wood', amount: 50 },
      acceptedAt: MIDNIGHT - 1,
    })
  })

  it('returns the same decision for identical inputs without mutating them', () => {
    const frozen = Object.freeze({ ...input })
    expect(decideClaim(frozen, NOW)).toEqual(decideClaim(frozen, NOW))
    expect(frozen).toEqual(input)
  })
})
