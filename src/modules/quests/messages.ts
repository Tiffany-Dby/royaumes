import { z } from 'zod'
import type { MessageHandler } from '@/platform/outbox/outbox'
import type { ClaimService } from './application/claim-service'
import { QUESTS_TOPICS } from './contracts'

const DepositedConfirmation = z.object({
  transferId: z.string().min(1),
  outcome: z.literal('deposited'),
})

export function createQuestsHandlers(service: ClaimService): Record<string, MessageHandler> {
  return {
    [QUESTS_TOPICS.transferResult]: async (message) => {
      await service.confirm(DepositedConfirmation.parse(message.payload))
    },
  }
}
