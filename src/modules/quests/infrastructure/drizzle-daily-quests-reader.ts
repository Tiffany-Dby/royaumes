import { and, eq } from 'drizzle-orm'
import type { Db } from '@/platform/db/client'
import type { EventStore } from '@/platform/event-store/event-store'
import type { ProjectionRunner } from '@/platform/projection/projection'
import type { DailyQuestsReader } from '../application/daily-quests-reader'
import { QUESTS } from '../domain/catalog'
import { questDayAt } from '../domain/quest-day'
import { progressProjection } from './progress-projection'
import { dailyProgress } from './schema'

export function createDrizzleDailyQuestsReader(
  db: Db,
  projections: ProjectionRunner,
  store: EventStore,
  clock: () => number,
): DailyQuestsReader {
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

      return {
        ok: true,
        value: {
          day,
          quests: QUESTS.map((quest) => {
            const progress = rows.find((row) => row.questId === quest.id)?.count ?? 0
            return { ...quest, progress, completed: progress >= quest.requiredCount }
          }),
        },
      }
    },
  }
}
