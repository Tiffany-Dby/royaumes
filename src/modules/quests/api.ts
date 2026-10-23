import { Hono } from 'hono'
import type { AppEnv } from '@/platform/http/types'
import type { DailyQuestsReader } from './application/daily-quests-reader'

export function createQuestsApi(reader: DailyQuestsReader) {
  return new Hono<AppEnv>().get('/', async (c) => {
    c.header('Cache-Control', 'private, no-store')
    const result = await reader.get(c.var.userId)
    return result.ok ? c.json(result.value) : c.json({ error: result.error }, 503)
  })
}

export type QuestsApi = ReturnType<typeof createQuestsApi>
