import type { EventStore, NewEvent } from '@/platform/event-store/event-store'
import type { ClaimEvent, ClaimRepository, ClaimState } from '../application/claim-repository'

export function createEventStoreClaimRepository(store: EventStore): ClaimRepository {
  return {
    async load(stream) {
      const stored = await store.read(stream)
      const state: ClaimState = { accepted: null, deliveredAt: null }
      for (const row of stored) {
        const event = row as unknown as ClaimEvent
        switch (event.type) {
          case 'QuestRewardClaimAccepted':
            state.accepted = event.data
            break
          case 'QuestRewardDelivered':
            state.deliveredAt = event.data.at
            break
        }
      }
      return { state, version: stored.at(-1)?.version ?? 0 }
    },
    async save(stream, expectedVersion, events, messages = []) {
      await store.append(stream, expectedVersion, events as unknown as NewEvent[], messages)
    },
  }
}
