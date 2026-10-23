import type { Db } from '@/platform/db/client'
import type { EventStore } from '@/platform/event-store/event-store'
import type { ProjectionRunner } from '@/platform/projection/projection'
import { createQuestsApi } from './api'
import { createDrizzleDailyQuestsReader } from './infrastructure/drizzle-daily-quests-reader'
import { createQuestsPersonalData } from './personal-data'

export interface QuestsModuleDeps {
  db: Db
  projections: ProjectionRunner
  store: EventStore
  clock?: () => number
}

/** Public server entry point; assembles daily reads, the API and personal-data export. */
export function createQuestsModule({
  db,
  projections,
  store,
  clock = () => Date.now(),
}: QuestsModuleDeps) {
  const reader = createDrizzleDailyQuestsReader(db, projections, store, clock)
  return {
    api: createQuestsApi(reader),
    personalData: createQuestsPersonalData(db, projections),
  }
}

export type { QuestsApi } from './api'
