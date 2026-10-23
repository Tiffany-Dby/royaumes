import type { NewMessage } from '@/platform/outbox/outbox'
import type { AcceptedClaim } from '../domain/claim'

export type PersistedClaim = AcceptedClaim & { readonly transferId: string }

export type ClaimEvent =
  | { type: 'QuestRewardClaimAccepted'; data: PersistedClaim }
  | { type: 'QuestRewardDelivered'; data: { transferId: string; at: number } }

export interface ClaimState {
  accepted: PersistedClaim | null
  deliveredAt: number | null
}

export interface ClaimRepository {
  load(stream: string): Promise<{ state: ClaimState; version: number }>
  /** Events and their messages commit together, or not at all. */
  save(
    stream: string,
    expectedVersion: number,
    events: ClaimEvent[],
    messages?: NewMessage[],
  ): Promise<void>
}
