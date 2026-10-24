import type { QuestDefinition, QuestId } from './catalog'
import { type QuestDay, questDayAt } from './quest-day'

type QuestActivity =
  | { type: 'BuildingUpgraded'; playerId: string; at: unknown }
  | { type: 'GameEnded'; result: unknown; humanPlayerIds: readonly string[]; at: unknown }
  | { type: 'TradeCompleted'; sellerId: string; buyerId: string | null; at: unknown }

export interface ProgressCredit {
  questId: QuestId
  day: QuestDay
  playerIds: readonly string[]
  count: 1
}

function gameplayDay(type: string, at: unknown): QuestDay {
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    throw new RangeError(`${type} requires a valid gameplay timestamp`)
  }
  return questDayAt(at)
}

/** Each eligible activity credits one objective using its gameplay day, including during replay. */
export function progressCredit(activity: QuestActivity): ProgressCredit {
  switch (activity.type) {
    case 'BuildingUpgraded':
      return {
        questId: 'builder',
        day: gameplayDay(activity.type, activity.at),
        playerIds: [activity.playerId],
        count: 1,
      }

    case 'GameEnded': {
      if (activity.result !== 'won' && activity.result !== 'lost') {
        throw new Error('GameEnded requires a won or lost result')
      }
      const day = gameplayDay(activity.type, activity.at)
      if (activity.humanPlayerIds.length === 0) {
        throw new Error('GameEnded requires Dungeon participation context')
      }
      return { questId: 'adventurer', day, playerIds: [...activity.humanPlayerIds], count: 1 }
    }

    case 'TradeCompleted':
      if (!activity.buyerId) throw new Error('TradeCompleted requires a successful buyer')
      return {
        questId: 'merchant',
        day: gameplayDay(activity.type, activity.at),
        playerIds: [activity.sellerId, activity.buyerId],
        count: 1,
      }
  }
}

/** Human membership comes from the host and join events, never companions or hero ID spelling. */
export function dungeonParticipant(
  type: string,
  data: Readonly<Record<string, unknown>>,
): string | null {
  if (type !== 'GameCreated' && type !== 'PlayerJoined') return null
  const playerId = type === 'GameCreated' ? data.hostId : data.playerId
  if (typeof playerId !== 'string' || playerId.trim().length === 0) {
    throw new Error(`${type} requires a nonempty human player identifier`)
  }
  return playerId
}

/** Refusal clears the pending buyer so a later successful acceptance receives the credit. */
export function marketBuyerAfter(
  trade: Readonly<{ sellerId: string; buyerId: string | null }>,
  change: { type: 'OfferAccepted' | 'PaymentRefused'; buyerId: string },
): string | null {
  if (change.type === 'OfferAccepted') {
    if (trade.buyerId !== null || change.buyerId === trade.sellerId) {
      throw new Error('OfferAccepted requires a different buyer and no pending payment')
    }
    return change.buyerId
  }
  if (trade.buyerId !== change.buyerId) {
    throw new Error('PaymentRefused must identify the current buyer')
  }
  return null
}

/** Presentation and decisions use the same catalog cap as the atomic persistence safeguard. */
export function questProgress(quest: QuestDefinition, count: number) {
  return { progress: Math.min(count, quest.requiredCount), completed: count >= quest.requiredCount }
}
