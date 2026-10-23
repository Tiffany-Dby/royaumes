import { sql } from 'drizzle-orm'
import { VILLAGE_CHANNEL_PREFIX } from '@/modules/realm/contracts'
import type { Projection } from '@/platform/projection/projection'
import { QUESTS } from '../domain/catalog'
import { questDayAt } from '../domain/quest-day'
import { dailyProgress } from './schema'

/** Version 1 tracks Builder only. The runner commits counters and checkpoint together. */
export const progressProjection: Projection = {
  name: 'quests-progress',
  version: 1,
  eventTypes: ['BuildingUpgraded'],

  async apply(event, tx) {
    if (event.type !== 'BuildingUpgraded' || !event.stream.startsWith(VILLAGE_CHANNEL_PREFIX))
      return
    const playerId = event.stream.slice(VILLAGE_CHANNEL_PREFIX.length)
    if (!playerId) return

    // Gameplay time is independent of database recording time, including relayed events.
    const at = event.data.at
    if (typeof at !== 'number' || !Number.isFinite(at)) {
      throw new RangeError('BuildingUpgraded requires a valid gameplay timestamp')
    }
    const day = questDayAt(at)
    const builder = QUESTS.find((quest) => quest.id === 'builder')
    if (!builder) throw new Error('Builder quest is missing from the catalog')

    await tx
      .insert(dailyProgress)
      .values({ playerId, day, questId: builder.id, count: 1 })
      .onConflictDoUpdate({
        target: [dailyProgress.playerId, dailyProgress.day, dailyProgress.questId],
        set: { count: sql`least(${dailyProgress.count} + 1, ${builder.requiredCount})` },
      })
  },

  async reset(tx) {
    await tx.delete(dailyProgress)
  },
}
