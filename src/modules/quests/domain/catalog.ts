/** Fixed daily objectives and rewards, shared by every player. */
export const QUESTS = [
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
] as const

export type QuestDefinition = (typeof QUESTS)[number]
export type QuestId = QuestDefinition['id']
