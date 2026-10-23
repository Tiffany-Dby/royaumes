import type { QuestDefinition } from './domain/catalog'
import type { QuestDay } from './domain/quest-day'

export type DailyQuest = QuestDefinition & { progress: number; completed: boolean }

/** Current UTC objectives and progress for the authenticated player. */
export interface DailyQuests {
  day: QuestDay
  quests: DailyQuest[]
}
