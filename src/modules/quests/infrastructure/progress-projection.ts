import { eq, sql } from 'drizzle-orm'
import { GAME_CHANNEL_PREFIX } from '@/modules/dungeon/contracts'
import { OFFER_STREAM_PREFIX } from '@/modules/market/contracts'
import { VILLAGE_CHANNEL_PREFIX } from '@/modules/realm/contracts'
import type { StoredEvent } from '@/platform/event-store/event-store'
import type { DbTransaction, Projection } from '@/platform/projection/projection'
import { QUESTS } from '../domain/catalog'
import {
  dungeonParticipant,
  marketBuyerAfter,
  type ProgressCredit,
  progressCredit,
} from '../domain/progress'
import { dailyProgress, gamePlayers, tradeParticipants, villages } from './schema'

const MARKET_EVENT_TYPES = [
  'OfferPublished',
  'OfferAccepted',
  'PaymentRefused',
  'TradeCompleted',
  'OfferRejected',
  'OfferWithdrawn',
]

async function recordProgress(
  tx: DbTransaction,
  { playerIds, day, questId, count }: ProgressCredit,
) {
  const quest = QUESTS.find((definition) => definition.id === questId)
  if (!quest) throw new Error(`Quest ${questId} is missing from the catalog`)
  await tx
    .insert(dailyProgress)
    .values(playerIds.map((playerId) => ({ playerId, day, questId, count })))
    .onConflictDoUpdate({
      target: [dailyProgress.playerId, dailyProgress.day, dailyProgress.questId],
      set: { count: sql`least(${dailyProgress.count} + 1, ${quest.requiredCount})` },
    })
}

/** Market correlates transfer replies before publishing events; only current attribution is needed. */
async function applyMarketEvent(event: StoredEvent, offerId: string, tx: DbTransaction) {
  if (event.type === 'OfferPublished') {
    if (event.data.offerId !== offerId)
      throw new Error('OfferPublished has a mismatched offer identifier')
    const sellerId = event.data.sellerId
    if (typeof sellerId !== 'string' || sellerId.trim().length === 0) {
      throw new Error('OfferPublished requires a nonempty seller identifier')
    }
    await tx.insert(tradeParticipants).values({ offerId, sellerId })
    return
  }

  const [trade] = await tx
    .select()
    .from(tradeParticipants)
    .where(eq(tradeParticipants.offerId, offerId))
  if (!trade) throw new Error(`${event.type} requires Market participation context`)

  switch (event.type) {
    case 'OfferAccepted':
    case 'PaymentRefused': {
      const buyerId = event.data.buyerId
      if (typeof buyerId !== 'string' || buyerId.trim().length === 0) {
        throw new Error(`${event.type} requires a nonempty buyer identifier`)
      }
      if (event.type === 'OfferAccepted') {
        const attempt = event.data.attempt
        if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt <= 0) {
          throw new Error('OfferAccepted requires a positive payment attempt')
        }
      }
      await tx
        .update(tradeParticipants)
        .set({ buyerId: marketBuyerAfter(trade, { type: event.type, buyerId }) })
        .where(eq(tradeParticipants.offerId, offerId))
      return
    }

    case 'TradeCompleted':
      await recordProgress(
        tx,
        progressCredit({
          type: 'TradeCompleted',
          sellerId: trade.sellerId,
          buyerId: trade.buyerId,
          at: event.data.at,
        }),
      )
      break

    case 'OfferRejected':
    case 'OfferWithdrawn':
      if (trade.buyerId !== null) throw new Error(`${event.type} cannot discard a pending buyer`)
      if (
        event.type === 'OfferWithdrawn' &&
        event.data.reason !== 'seller' &&
        event.data.reason !== 'expired'
      ) {
        throw new Error('OfferWithdrawn requires a seller or expired reason')
      }
      break

    default:
      throw new Error(`Unsupported Market event ${event.type}`)
  }
  await tx.delete(tradeParticipants).where(eq(tradeParticipants.offerId, offerId))
}

/** The runner commits progress, participant context and the checkpoint in one transaction. */
export const progressProjection: Projection = {
  name: 'quests-progress',
  version: 4,
  eventTypes: [
    'VillageFounded',
    'BuildingUpgraded',
    'GameCreated',
    'PlayerJoined',
    'GameEnded',
    ...MARKET_EVENT_TYPES,
  ],

  async apply(event, tx) {
    if (event.type === 'BuildingUpgraded' || event.type === 'VillageFounded') {
      if (!event.stream.startsWith(VILLAGE_CHANNEL_PREFIX)) return
      const playerId = event.stream.slice(VILLAGE_CHANNEL_PREFIX.length)
      if (!playerId) return
      if (event.type === 'VillageFounded') {
        await tx.insert(villages).values({ playerId }).onConflictDoNothing()
      } else {
        await recordProgress(
          tx,
          progressCredit({ type: 'BuildingUpgraded', playerId, at: event.data.at }),
        )
      }
      return
    }

    if (MARKET_EVENT_TYPES.includes(event.type)) {
      if (!event.stream.startsWith(OFFER_STREAM_PREFIX)) return
      const offerId = event.stream.slice(OFFER_STREAM_PREFIX.length)
      if (!offerId) return
      await applyMarketEvent(event, offerId, tx)
      return
    }

    if (!event.stream.startsWith(GAME_CHANNEL_PREFIX)) return
    const gameId = event.stream.slice(GAME_CHANNEL_PREFIX.length)
    if (!gameId) return

    const playerId = dungeonParticipant(event.type, event.data)
    if (playerId !== null) {
      if (event.type === 'PlayerJoined') {
        const [member] = await tx
          .select({ playerId: gamePlayers.playerId })
          .from(gamePlayers)
          .where(eq(gamePlayers.gameId, gameId))
          .limit(1)
        if (!member) throw new Error('PlayerJoined requires Dungeon participation context')
      }
      await tx.insert(gamePlayers).values({ gameId, playerId }).onConflictDoNothing()
      return
    }

    if (event.type === 'GameEnded') {
      const members = await tx
        .select({ playerId: gamePlayers.playerId })
        .from(gamePlayers)
        .where(eq(gamePlayers.gameId, gameId))
      // heroIds also contains companions; recorded human membership determines eligibility.
      await recordProgress(
        tx,
        progressCredit({
          type: 'GameEnded',
          result: event.data.result,
          at: event.data.at,
          humanPlayerIds: members.map((member) => member.playerId),
        }),
      )
      await tx.delete(gamePlayers).where(eq(gamePlayers.gameId, gameId))
    }
  },

  async reset(tx) {
    await tx.delete(villages)
    await tx.delete(tradeParticipants)
    await tx.delete(gamePlayers)
    await tx.delete(dailyProgress)
  },
}
