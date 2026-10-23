import { asc, eq } from 'drizzle-orm'
import type { Db } from '@/platform/db/client'
import type { PersonalDataContributor } from '@/platform/privacy/privacy'
import type { ProjectionRunner } from '@/platform/projection/projection'
import { progressProjection } from './infrastructure/progress-projection'
import { dailyProgress } from './infrastructure/schema'

/**
 * Exports the player's recorded progress without copying names or other players' data.
 * Under ADR-0008 and ADR-0010, player references and progress are intentionally retained
 * after identity deletion. They remain pseudonymous, not fully anonymous or physically
 * erased. No redact or erase hook is needed for these name-free, replayable counters:
 * rebuilding from the rewritten journal produces the same retained data.
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
      return { progress }
    },
  }
}
