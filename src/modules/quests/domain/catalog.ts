/** Fixed quests and rewards for every player; French display text is shared by the API and UI. */
export const QUESTS = [
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
] as const

export type QuestDefinition = (typeof QUESTS)[number]
export type QuestId = QuestDefinition['id']
