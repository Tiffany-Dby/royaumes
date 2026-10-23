import { REALM_TOPICS, type TransferResult } from '@/modules/realm/contracts'
import { withOptimisticRetry } from '@/platform/event-store/retry'
import {
  CLAIM_STREAM_PREFIX,
  CLAIM_TRANSFER_PREFIX,
  type ClaimKey,
  claimStream,
  claimTransferId,
  QUESTS_TOPICS,
} from '../contracts'
import type { QuestId } from '../domain/catalog'
import { type ClaimError, decideClaim } from '../domain/claim'
import { type QuestDay, questDayAt } from '../domain/quest-day'
import type { ClaimRepository, PersistedClaim } from './claim-repository'

export interface ClaimEligibilityReader {
  read(
    key: ClaimKey,
  ): Promise<{ ready: false } | { ready: true; progress: number; villageExists: boolean }>
}

export type ClaimResult =
  | { ok: true; claim: PersistedClaim }
  | { ok: false; error: ClaimError | { code: 'QUESTS_NOT_READY' } }

export function createClaimService(
  repo: ClaimRepository,
  eligibility: ClaimEligibilityReader,
  clock = () => Date.now(),
) {
  function claim(playerId: string, questId: QuestId, expectedDay?: QuestDay): Promise<ClaimResult> {
    // The displayed day is a precondition; retries keep it and eligibility uses the final server time.
    const key = { playerId, questId, day: expectedDay ?? questDayAt(clock()) }
    const stream = claimStream(key)
    return withOptimisticRetry(async () => {
      const { state, version } = await repo.load(stream)
      if (state.accepted) return { ok: false, error: { code: 'ALREADY_CLAIMED' } }
      const facts = await eligibility.read(key)
      if (!facts.ready) return { ok: false, error: { code: 'QUESTS_NOT_READY' } }
      const decision = decideClaim(
        {
          ...key,
          progress: facts.progress,
          villageExists: facts.villageExists,
          alreadyClaimed: false,
        },
        clock(),
      )
      if (!decision.ok) return decision
      const accepted = { ...decision.claim, transferId: claimTransferId(key) }
      await repo.save(
        stream,
        version,
        [{ type: 'QuestRewardClaimAccepted', data: accepted }],
        [
          {
            topic: REALM_TOPICS.deposit,
            payload: {
              transferId: accepted.transferId,
              playerId,
              resources: { [accepted.reward.resource]: accepted.reward.amount },
              replyTo: QUESTS_TOPICS.transferResult,
            },
          },
        ],
      )
      return { ok: true, claim: accepted }
    })
  }

  async function confirm(result: Pick<TransferResult, 'transferId' | 'outcome'>): Promise<void> {
    if (
      result.outcome !== 'deposited' ||
      !result.transferId.startsWith(`${CLAIM_TRANSFER_PREFIX}${CLAIM_STREAM_PREFIX}`)
    ) {
      throw new Error('Expected a deposited Quests reward confirmation')
    }
    const stream = result.transferId.slice(CLAIM_TRANSFER_PREFIX.length)
    return withOptimisticRetry(async () => {
      const { state, version } = await repo.load(stream)
      const accepted = state.accepted
      if (
        !accepted ||
        accepted.transferId !== result.transferId ||
        claimStream(accepted) !== stream ||
        claimTransferId(accepted) !== result.transferId
      ) {
        throw new Error(
          'Confirmation must match an accepted claim and its exact transfer identifier',
        )
      }
      if (state.deliveredAt !== null) return
      await repo.save(stream, version, [
        { type: 'QuestRewardDelivered', data: { transferId: result.transferId, at: clock() } },
      ])
    })
  }

  return { claim, confirm }
}

export type ClaimService = ReturnType<typeof createClaimService>
