import type { PersonalDataContributor } from '@/platform/privacy/privacy'

/**
 * Valid only while Quests persists no player data. Update this contributor when
 * persistence is introduced, including export and any required erasure or redaction.
 * There are currently no records or events to export, erase or redact.
 */
export function createQuestsPersonalData(): PersonalDataContributor {
  return {
    name: 'quests',
    async export() {
      return null
    },
  }
}
