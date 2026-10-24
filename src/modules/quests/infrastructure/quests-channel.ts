import { GAME_CHANNEL_PREFIX } from '@/modules/dungeon/contracts'
import { OFFER_STREAM_PREFIX } from '@/modules/market/contracts'
import { villageChannel } from '@/modules/realm/contracts'
import type { EventStore, StoredEvent } from '@/platform/event-store/event-store'
import type { ChannelPolicy } from '@/platform/realtime/channel-policy'
import { CLAIM_STREAM_PREFIX, QUESTS_CHANNEL } from '../contracts'

const EVENT_TYPES = [
  'VillageFounded',
  'BuildingUpgraded',
  'GameEnded',
  'TradeCompleted',
  'QuestRewardClaimAccepted',
  'QuestRewardDelivered',
]

async function concernsPlayer(store: EventStore, event: StoredEvent, playerId: string) {
  switch (event.type) {
    case 'VillageFounded':
    case 'BuildingUpgraded':
      return event.stream === villageChannel(playerId)

    case 'QuestRewardClaimAccepted':
    case 'QuestRewardDelivered':
      return event.stream.startsWith(`${CLAIM_STREAM_PREFIX}${encodeURIComponent(playerId)}:`)

    case 'GameEnded': {
      if (
        !event.stream.startsWith(GAME_CHANNEL_PREFIX) ||
        event.stream.length === GAME_CHANNEL_PREFIX.length
      )
        return false
      // Completion removes projection membership; only published human membership is relevant.
      const history = await store.read(event.stream)
      return history.some(
        (entry) =>
          entry.version <= event.version &&
          ((entry.type === 'GameCreated' && entry.data.hostId === playerId) ||
            (entry.type === 'PlayerJoined' && entry.data.playerId === playerId)),
      )
    }

    case 'TradeCompleted': {
      if (
        !event.stream.startsWith(OFFER_STREAM_PREFIX) ||
        event.stream.length === OFFER_STREAM_PREFIX.length
      )
        return false
      const history = await store.read(event.stream)
      let seller: unknown
      let buyer: unknown
      // Identify the successful participants without calculating progress or exposing the offer.
      for (const entry of history) {
        if (entry.version > event.version) break
        if (entry.type === 'OfferPublished') seller = entry.data.sellerId
        if (entry.type === 'OfferAccepted') buyer = entry.data.buyerId
        if (entry.type === 'PaymentRefused' && entry.data.buyerId === buyer) buyer = undefined
      }
      return seller === playerId || buyer === playerId
    }

    default:
      return false
  }
}

/** Only invalidations leave this channel; the authenticated API remains authoritative. */
export function createQuestsChannel(store: EventStore): ChannelPolicy {
  return {
    prefix: QUESTS_CHANNEL,
    canSubscribe: (channel) => channel === QUESTS_CHANNEL,
    redact: true,
    source: (playerId) => {
      let cursor = 0
      return {
        async start() {
          cursor = await store.lastPosition()
          return cursor
        },
        async read(after) {
          const afterPosition = Math.max(cursor, after)
          // Advance past ignored types only to a position captured before the filtered read.
          const target = await store.lastPosition()
          if (target <= afterPosition) return []
          const fresh = await store.readAll({
            types: EVENT_TYPES,
            afterPosition,
          })
          const notifications: StoredEvent[] = []
          for (const event of fresh) {
            if (await concernsPlayer(store, event, playerId)) {
              notifications.push({
                position: event.position,
                version: event.position,
                stream: QUESTS_CHANNEL,
                type: 'QuestsChanged',
                data: {},
                occurredAt: event.occurredAt,
              })
            }
            // Advance even when this player receives nothing; reconnects use the client's cursor.
            cursor = event.position
          }
          cursor = Math.max(cursor, target)
          return notifications
        },
      }
    },
  }
}
