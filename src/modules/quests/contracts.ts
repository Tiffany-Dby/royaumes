import type { QuestDefinition, QuestId } from './domain/catalog'
import { type QuestDay, questInstanceId } from './domain/quest-day'

export const CLAIM_STREAM_PREFIX = 'quests-claim-'
export const CLAIM_TRANSFER_PREFIX = 'quests:reward:'
export const QUESTS_TOPICS = { transferResult: 'quests.transfer-result' } as const

export interface ClaimKey {
  playerId: string
  day: QuestDay
  questId: QuestId
}

export const claimStream = (key: ClaimKey) =>
  `${CLAIM_STREAM_PREFIX}${encodeURIComponent(key.playerId)}:${questInstanceId(key.day, key.questId)}`

export const claimTransferId = (key: ClaimKey) => `${CLAIM_TRANSFER_PREFIX}${claimStream(key)}`

export type DailyQuest = QuestDefinition & { progress: number; completed: boolean }

/** Current UTC objectives and progress for the authenticated player. */
export interface DailyQuests {
  day: QuestDay
  quests: DailyQuest[]
}
