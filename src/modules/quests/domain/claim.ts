import { QUESTS, type QuestDefinition, type QuestId } from './catalog'
import { type QuestDay, questDayAt } from './quest-day'

export interface ClaimInput {
  playerId: string
  questId: QuestId
  day: QuestDay
  progress: number
  villageExists: boolean
  alreadyClaimed: boolean
}

/** Acceptance records the reward owed; it neither confirms delivery nor expires at midnight. */
export type AcceptedClaim = Readonly<{
  playerId: string
  questId: QuestId
  day: QuestDay
  reward: Readonly<{ resource: QuestDefinition['reward']['resource']; amount: number }>
  acceptedAt: number
}>

export type ClaimError =
  | { code: 'ALREADY_CLAIMED' }
  | { code: 'NOT_CURRENT_DAY' }
  | { code: 'VILLAGE_REQUIRED' }
  | { code: 'QUEST_INCOMPLETE' }

export type ClaimDecision = { ok: true; claim: AcceptedClaim } | { ok: false; error: ClaimError }

/** Facts must concern the same player/day/quest; now is the final decision timestamp. */
export function decideClaim(input: ClaimInput, now: number): ClaimDecision {
  if (input.alreadyClaimed) return { ok: false, error: { code: 'ALREADY_CLAIMED' } }
  if (questDayAt(now) !== input.day) return { ok: false, error: { code: 'NOT_CURRENT_DAY' } }
  if (!input.villageExists) return { ok: false, error: { code: 'VILLAGE_REQUIRED' } }

  const quest = QUESTS.find((definition) => definition.id === input.questId)
  if (!quest) throw new Error(`Quest ${input.questId} is missing from the catalog`)
  if (input.progress >= quest.requiredCount) {
    return {
      ok: true,
      claim: {
        playerId: input.playerId,
        questId: input.questId,
        day: input.day,
        reward: { ...quest.reward },
        acceptedAt: now,
      },
    }
  }
  return { ok: false, error: { code: 'QUEST_INCOMPLETE' } }
}
