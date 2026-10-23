import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '@/platform/http/types'
import { validateJson } from '@/platform/http/validate'
import type { ClaimService } from './application/claim-service'
import type { DailyQuestsReader } from './application/daily-quests-reader'
import { QUESTS } from './domain/catalog'
import type { ClaimError } from './domain/claim'
import { questDayAt } from './domain/quest-day'

const ClaimInput = z.object({
  day: z.iso.date().transform((day) => questDayAt(Date.parse(`${day}T00:00:00.000Z`))),
})

const STATUS: Record<ClaimError['code'] | 'QUESTS_NOT_READY', 409 | 503> = {
  ALREADY_CLAIMED: 409,
  NOT_CURRENT_DAY: 409,
  VILLAGE_REQUIRED: 409,
  QUEST_INCOMPLETE: 409,
  QUESTS_NOT_READY: 503,
}

export function createQuestsApi(
  reader: DailyQuestsReader,
  claims: ClaimService,
  dispatch: () => Promise<unknown>,
) {
  async function dispatchPending() {
    try {
      await dispatch()
    } catch (error) {
      // Acceptance is already durable; dispatch failures must not turn it into a failed claim.
      console.error('Quests outbox dispatch failed', error)
    }
  }

  return new Hono<AppEnv>()
    .get('/', async (c) => {
      c.header('Cache-Control', 'private, no-store')
      await dispatchPending()
      const result = await reader.get(c.var.userId)
      return result.ok ? c.json(result.value) : c.json({ error: result.error }, 503)
    })
    .post('/:id/claim', validateJson(ClaimInput), async (c) => {
      c.header('Cache-Control', 'private, no-store')
      const quest = QUESTS.find((definition) => definition.id === c.req.param('id'))
      if (!quest) return c.json({ error: { code: 'QUEST_NOT_FOUND' as const } }, 404)
      const result = await claims.claim(c.var.userId, quest.id, c.req.valid('json').day)
      if (!result.ok) {
        if (result.error.code === 'ALREADY_CLAIMED') await dispatchPending()
        return c.json({ error: result.error }, STATUS[result.error.code])
      }
      await dispatchPending()
      const { questId, day, reward } = result.claim
      return c.json({ accepted: true as const, claim: { questId, day, reward } }, 202)
    })
}

export type QuestsApi = ReturnType<typeof createQuestsApi>
