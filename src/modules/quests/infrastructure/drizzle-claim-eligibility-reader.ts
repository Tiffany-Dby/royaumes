import { and, eq } from 'drizzle-orm'
import type { Db } from '@/platform/db/client'
import type { EventStore } from '@/platform/event-store/event-store'
import type { ProjectionRunner } from '@/platform/projection/projection'
import type { ClaimEligibilityReader } from '../application/claim-service'
import { progressProjection } from './progress-projection'
import { dailyProgress, villages } from './schema'

export function createDrizzleClaimEligibilityReader(
  db: Db,
  projections: ProjectionRunner,
  store: EventStore,
): ClaimEligibilityReader {
  return {
    async read(key) {
      const target = await store.lastPosition()
      await projections.catchUp(progressProjection)
      if ((await projections.positionOf(progressProjection.name)) < target) return { ready: false }
      const [progress] = await db
        .select({ count: dailyProgress.count })
        .from(dailyProgress)
        .where(
          and(
            eq(dailyProgress.playerId, key.playerId),
            eq(dailyProgress.day, key.day),
            eq(dailyProgress.questId, key.questId),
          ),
        )
      const [village] = await db
        .select({ playerId: villages.playerId })
        .from(villages)
        .where(eq(villages.playerId, key.playerId))
      return { ready: true, progress: progress?.count ?? 0, villageExists: village !== undefined }
    },
  }
}
