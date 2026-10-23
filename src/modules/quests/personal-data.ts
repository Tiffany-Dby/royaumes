import { asc, eq, or } from 'drizzle-orm'
import type { Db } from '@/platform/db/client'
import type { EventStore } from '@/platform/event-store/event-store'
import type { PersonalDataContributor } from '@/platform/privacy/privacy'
import type { ProjectionRunner } from '@/platform/projection/projection'
import type { PersistedClaim } from './application/claim-repository'
import { CLAIM_STREAM_PREFIX } from './contracts'
import { progressProjection } from './infrastructure/progress-projection'
import { dailyProgress, gamePlayers, tradeParticipants, villages } from './infrastructure/schema'

/**
 * Exports Village existence, progress, participation and claim history without names or
 * counterparties. Claim rewards retain their original amounts. Under ADR-0008 and ADR-0010,
 * replay-essential player references remain after identity deletion; terminal activities remove their context.
 * Retained data is pseudonymous, not fully anonymous or physically erased. No redact
 * or erase hook is needed for these name-free records: replaying the rewritten journal
 * produces the same retained data.
 */
export function createQuestsPersonalData(
  db: Db,
  projections: ProjectionRunner,
  store: EventStore,
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
      const [village] = await db.select().from(villages).where(eq(villages.playerId, playerId))
      const history = await store.readAll({
        streamPrefix: CLAIM_STREAM_PREFIX,
        types: ['QuestRewardClaimAccepted', 'QuestRewardDelivered'],
      })
      const claims = history
        .filter(
          (event) => event.type === 'QuestRewardClaimAccepted' && event.data.playerId === playerId,
        )
        .map((event) => {
          const accepted = event.data as unknown as PersistedClaim
          const delivered = history.find(
            (confirmation) =>
              confirmation.stream === event.stream &&
              confirmation.type === 'QuestRewardDelivered' &&
              confirmation.data.transferId === accepted.transferId,
          )
          return {
            day: accepted.day,
            questId: accepted.questId,
            reward: accepted.reward,
            acceptedAt: accepted.acceptedAt,
            transferId: accepted.transferId,
            deliveredAt: delivered?.data.at ?? null,
          }
        })
      return {
        villageExists: village !== undefined,
        progress,
        dungeonParticipations,
        marketParticipations,
        claims,
      }
    },
  }
}
