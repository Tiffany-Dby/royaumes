import { describe, expect, expectTypeOf, it } from 'vitest'
import { QUESTS, type QuestDefinition, type QuestId } from './catalog'

describe('Daily quest catalog', () => {
  it('defines the three fixed objectives and rewards for every player', () => {
    expect(QUESTS).toEqual([
      {
        id: 'builder',
        name: 'Le Bâtisseur',
        objective: 'Améliorer 2 bâtiments du Village.',
        requiredCount: 2,
        reward: { resource: 'wood', amount: 50 },
      },
      {
        id: 'adventurer',
        name: 'L’Aventurier',
        objective: 'Terminer une expédition dans le Donjon, gagnée ou perdue.',
        requiredCount: 1,
        reward: { resource: 'stone', amount: 75 },
      },
      {
        id: 'merchant',
        name: 'Le Marchand',
        objective: 'Conclure un échange sur le Marché, comme vendeur ou acheteur.',
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
