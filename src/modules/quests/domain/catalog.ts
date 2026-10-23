/** Fixed daily objectives and rewards, shared by every player. */
export const QUESTS = [
  {
    id: 'builder',
    name: 'The Builder',
    objective: 'Upgrade 2 Village buildings.',
    requiredCount: 2,
    reward: { resource: 'wood', amount: 50 },
  },
  {
    id: 'adventurer',
    name: 'The Adventurer',
    objective: 'Complete 1 Dungeon expedition, won or lost.',
    requiredCount: 1,
    reward: { resource: 'stone', amount: 75 },
  },
  {
    id: 'merchant',
    name: 'The Merchant',
    objective: 'Complete 1 successful Market trade as seller or buyer.',
    requiredCount: 1,
    reward: { resource: 'gold', amount: 100 },
  },
] as const

export type QuestDefinition = (typeof QUESTS)[number]
export type QuestId = QuestDefinition['id']
