import { integer, pgSchema, primaryKey, text } from 'drizzle-orm/pg-core'
import type { QuestId } from '../domain/catalog'
import type { QuestDay } from '../domain/quest-day'

/** Quests owns its derived progress; gameplay events remain in the platform journal. */
export const quests = pgSchema('quests')

/** One capped counter per player, UTC day and quest. No identifying names are copied. */
export const dailyProgress = quests.table(
  'daily_progress',
  {
    playerId: text('player_id').notNull(),
    day: text('day').$type<QuestDay>().notNull(),
    questId: text('quest_id').$type<QuestId>().notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.playerId, t.day, t.questId] })],
)

/** Human membership survives UTC day boundaries and is removed when the expedition ends. */
export const gamePlayers = quests.table(
  'game_players',
  {
    gameId: text('game_id').notNull(),
    playerId: text('player_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.playerId] })],
)

/** Current trade attribution survives day boundaries; terminal offers need no context. */
export const tradeParticipants = quests.table('trade_participants', {
  offerId: text('offer_id').primaryKey(),
  sellerId: text('seller_id').notNull(),
  buyerId: text('buyer_id'),
})
