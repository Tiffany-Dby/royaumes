import { and, eq } from 'drizzle-orm'
import type { Db } from '@/platform/db/client'
import type { EventStore } from '@/platform/event-store/event-store'
import type { ProjectionRunner } from '@/platform/projection/projection'
import type { DailyQuestsReader } from '../application/daily-quests-reader'
import { claimStream, type RewardStatus } from '../contracts'
import { QUESTS } from '../domain/catalog'
import { rewardStatusFor } from '../domain/claim'
import { questProgress } from '../domain/progress'
import { questDayAt } from '../domain/quest-day'
import { createEventStoreClaimRepository } from './event-store-claim-repository'
import { progressProjection } from './progress-projection'
import { dailyProgress, villages } from './schema'

export function createDrizzleDailyQuestsReader(
  db: Db,
  projections: ProjectionRunner,
  store: EventStore,
  clock: () => number,
): DailyQuestsReader {
  const claims = createEventStoreClaimRepository(store)
  return {
    async get(playerId) {
      const target = await store.lastPosition()
      await projections.catchUp(progressProjection)
      // Catch-up can stop at a recent journal gap without throwing. Do not report partial progress.
      if ((await projections.positionOf(progressProjection.name)) < target) {
        return { ok: false, error: { code: 'QUESTS_NOT_READY' } }
      }

      // Select the day after catch-up, which may have crossed UTC midnight.
      const day = questDayAt(clock())
      const rows = await db
        .select({ questId: dailyProgress.questId, count: dailyProgress.count })
        .from(dailyProgress)
        .where(and(eq(dailyProgress.playerId, playerId), eq(dailyProgress.day, day)))
      const [village] = await db
        .select({ playerId: villages.playerId })
        .from(villages)
        .where(eq(villages.playerId, playerId))
      const quests = await Promise.all(
        QUESTS.map(async (quest) => {
          const { progress, completed } = questProgress(
            quest,
            rows.find((row) => row.questId === quest.id)?.count ?? 0,
          )
          const { state } = await claims.load(claimStream({ playerId, day, questId: quest.id }))
          const rewardStatus: RewardStatus = rewardStatusFor({
            completed,
            villageExists: Boolean(village),
            accepted: Boolean(state.accepted),
            deliveredAt: state.deliveredAt,
          })
          return { ...quest, progress, completed, rewardStatus }
        }),
      )

      return {
        ok: true,
        value: { day, quests },
      }
    },
  }
}
