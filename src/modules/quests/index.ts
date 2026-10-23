import type { Db } from '@/platform/db/client'
import type { EventStore } from '@/platform/event-store/event-store'
import type { ProjectionRunner } from '@/platform/projection/projection'
import { createQuestsApi } from './api'
import { createClaimService } from './application/claim-service'
import { createDrizzleClaimEligibilityReader } from './infrastructure/drizzle-claim-eligibility-reader'
import { createDrizzleDailyQuestsReader } from './infrastructure/drizzle-daily-quests-reader'
import { createEventStoreClaimRepository } from './infrastructure/event-store-claim-repository'
import { createQuestsHandlers } from './messages'
import { createQuestsPersonalData } from './personal-data'

export interface QuestsModuleDeps {
  db: Db
  projections: ProjectionRunner
  store: EventStore
  clock?: () => number
}

/** Public server entry point; assembles reads, claims, confirmations and personal-data export. */
export function createQuestsModule({
  db,
  projections,
  store,
  clock = () => Date.now(),
}: QuestsModuleDeps) {
  const reader = createDrizzleDailyQuestsReader(db, projections, store, clock)
  const claims = createClaimService(
    createEventStoreClaimRepository(store),
    createDrizzleClaimEligibilityReader(db, projections, store),
    clock,
  )
  return {
    claims,
    handlers: createQuestsHandlers(claims),
    api: createQuestsApi(reader),
    personalData: createQuestsPersonalData(db, projections, store),
  }
}

export type { QuestsApi } from './api'
