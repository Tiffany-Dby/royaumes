import { eq, sql } from 'drizzle-orm'
import { GAME_CHANNEL_PREFIX } from '@/modules/dungeon/contracts'
import { VILLAGE_CHANNEL_PREFIX } from '@/modules/realm/contracts'
import type { StoredEvent } from '@/platform/event-store/event-store'
import type { DbTransaction, Projection } from '@/platform/projection/projection'
import { QUESTS, type QuestId } from '../domain/catalog'
import { type QuestDay, questDayAt } from '../domain/quest-day'
import { dailyProgress, gamePlayers } from './schema'

/** Gameplay time remains authoritative when events are recorded or relayed later. */
function gameplayDay(event: StoredEvent): QuestDay {
  const at = event.data.at
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    throw new RangeError(`${event.type} requires a valid gameplay timestamp`)
  }
  return questDayAt(at)
}

async function recordProgress(
  tx: DbTransaction,
  playerIds: string[],
  day: QuestDay,
  questId: QuestId,
) {
  const quest = QUESTS.find((definition) => definition.id === questId)
  if (!quest) throw new Error(`Quest ${questId} is missing from the catalog`)
  await tx
    .insert(dailyProgress)
    .values(playerIds.map((playerId) => ({ playerId, day, questId, count: 1 })))
    .onConflictDoUpdate({
      target: [dailyProgress.playerId, dailyProgress.day, dailyProgress.questId],
      set: { count: sql`least(${dailyProgress.count} + 1, ${quest.requiredCount})` },
    })
}

/** The runner commits progress, human membership and the checkpoint in one transaction. */
export const progressProjection: Projection = {
  name: 'quests-progress',
  version: 2,
  eventTypes: ['BuildingUpgraded', 'GameCreated', 'PlayerJoined', 'GameEnded'],

  async apply(event, tx) {
    if (event.type === 'BuildingUpgraded') {
      if (!event.stream.startsWith(VILLAGE_CHANNEL_PREFIX)) return
      const playerId = event.stream.slice(VILLAGE_CHANNEL_PREFIX.length)
      if (!playerId) return
      await recordProgress(tx, [playerId], gameplayDay(event), 'builder')
      return
    }

    if (!event.stream.startsWith(GAME_CHANNEL_PREFIX)) return
    const gameId = event.stream.slice(GAME_CHANNEL_PREFIX.length)
    if (!gameId) return

    switch (event.type) {
      case 'GameCreated':
      case 'PlayerJoined': {
        const playerId = event.type === 'GameCreated' ? event.data.hostId : event.data.playerId
        if (typeof playerId !== 'string' || playerId.trim().length === 0) {
          throw new Error(`${event.type} requires a nonempty human player identifier`)
        }
        if (event.type === 'PlayerJoined') {
          const [member] = await tx
            .select({ playerId: gamePlayers.playerId })
            .from(gamePlayers)
            .where(eq(gamePlayers.gameId, gameId))
            .limit(1)
          if (!member) throw new Error('PlayerJoined requires Dungeon participation context')
        }
        // Only membership events identify humans; CompanionAdded never enters this table.
        await tx.insert(gamePlayers).values({ gameId, playerId }).onConflictDoNothing()
        return
      }

      case 'GameEnded': {
        if (event.data.result !== 'won' && event.data.result !== 'lost') {
          throw new Error('GameEnded requires a won or lost result')
        }
        const day = gameplayDay(event)
        const members = await tx
          .select({ playerId: gamePlayers.playerId })
          .from(gamePlayers)
          .where(eq(gamePlayers.gameId, gameId))
        if (members.length === 0)
          throw new Error('GameEnded requires Dungeon participation context')
        // heroIds also contains companions; recorded human membership determines eligibility.
        await recordProgress(
          tx,
          members.map((member) => member.playerId),
          day,
          'adventurer',
        )
        await tx.delete(gamePlayers).where(eq(gamePlayers.gameId, gameId))
        return
      }
    }
  },

  async reset(tx) {
    await tx.delete(gamePlayers)
    await tx.delete(dailyProgress)
  },
}
