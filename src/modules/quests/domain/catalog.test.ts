import { describe, expect, expectTypeOf, it } from 'vitest'
import { QUESTS, type QuestDefinition, type QuestId } from './catalog'

describe('Daily quest catalog', () => {
  it('defines the three fixed objectives and rewards for every player', () => {
    expect(QUESTS).toEqual([
      {
        id: 'builder',
        name: 'The Builder',
        requiredCount: 2,
        reward: { resource: 'wood', amount: 50 },
      },
      {
        id: 'adventurer',
        name: 'The Adventurer',
        requiredCount: 1,
        reward: { resource: 'stone', amount: 75 },
      },
      {
        id: 'merchant',
        name: 'The Merchant',
        requiredCount: 1,
        reward: { resource: 'gold', amount: 100 },
      },
    ])
  })

  it('assigns a unique identifier to each quest', () => {
    const ids = QUESTS.map((quest) => quest.id)
    expect(new Set(ids).size).toBe(3)
  })

  it('keeps identifiers strongly typed and definitions readonly', () => {
    expectTypeOf<QuestId>().toEqualTypeOf<'builder' | 'adventurer' | 'merchant'>()
    expectTypeOf(QUESTS).not.toExtend<QuestDefinition[]>()
    expectTypeOf<QuestDefinition>().toEqualTypeOf<Readonly<QuestDefinition>>()
    expectTypeOf<QuestDefinition['reward']>().toEqualTypeOf<Readonly<QuestDefinition['reward']>>()
  })
})
