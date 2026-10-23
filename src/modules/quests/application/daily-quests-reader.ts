import type { DailyQuests } from '../contracts'

export type DailyQuestsResult =
  | { ok: true; value: DailyQuests }
  | { ok: false; error: { code: 'QUESTS_NOT_READY' } }

export interface DailyQuestsReader {
  /** Reads only this player's current day, after catching up through a captured journal position. */
  get(playerId: string): Promise<DailyQuestsResult>
}
