import { asc, eq, or } from 'drizzle-orm'
import type { Db } from '@/platform/db/client'
import type { PersonalDataContributor } from '@/platform/privacy/privacy'
import type { ProjectionRunner } from '@/platform/projection/projection'
import { progressProjection } from './infrastructure/progress-projection'
import { dailyProgress, gamePlayers, tradeParticipants } from './infrastructure/schema'

/**
 * Exports the player's progress and outstanding Dungeon and Market participation without
 * names, counterparties or resource amounts. Under ADR-0008 and ADR-0010, replay-essential
 * player references remain after identity deletion; terminal activities remove their context.
 * Retained data is pseudonymous, not fully anonymous or physically erased. No redact
 * or erase hook is needed for these name-free records: replaying the rewritten journal
 * produces the same retained data.
 */
export function createQuestsPersonalData(
  db: Db,
  projections: ProjectionRunner,
): PersonalDataContributor {
  return {
    name: 'quests',
    async export(playerId) {
      await projections.catchUp(progressProjection)
      const progress = await db
        .select({
          day: dailyProgress.day,
          questId: dailyProgress.questId,
          count: dailyProgress.count,
        })
        .from(dailyProgress)
        .where(eq(dailyProgress.playerId, playerId))
        .orderBy(asc(dailyProgress.day), asc(dailyProgress.questId))
      const dungeonParticipations = await db
        .select({ gameId: gamePlayers.gameId })
        .from(gamePlayers)
        .where(eq(gamePlayers.playerId, playerId))
        .orderBy(asc(gamePlayers.gameId))
      const trades = await db
        .select({ offerId: tradeParticipants.offerId, sellerId: tradeParticipants.sellerId })
        .from(tradeParticipants)
        .where(
          or(eq(tradeParticipants.sellerId, playerId), eq(tradeParticipants.buyerId, playerId)),
        )
        .orderBy(asc(tradeParticipants.offerId))
      const marketParticipations = trades.map((trade) => ({
        offerId: trade.offerId,
        role: trade.sellerId === playerId ? 'seller' : 'buyer',
      }))
      return { progress, dungeonParticipations, marketParticipations }
    },
  }
}
