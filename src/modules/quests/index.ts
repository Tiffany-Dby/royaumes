import type { Db } from '@/platform/db/client'
import type { ProjectionRunner } from '@/platform/projection/projection'
import { createQuestsPersonalData } from './personal-data'

export interface QuestsModuleDeps {
  db: Db
  projections: ProjectionRunner
}

/** Public server entry point; exposes only the personal-data contributor. */
export function createQuestsModule({ db, projections }: QuestsModuleDeps) {
  return { personalData: createQuestsPersonalData(db, projections) }
}
