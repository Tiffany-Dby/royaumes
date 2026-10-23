import type { QuestId } from './catalog'

declare const questDayBrand: unique symbol

/** UTC calendar date derived from a timestamp, rather than an arbitrary string. */
export type QuestDay = string & { readonly [questDayBrand]: true }

/** A daily objective's identity; player ownership is handled separately. */
export type QuestInstanceId = `${QuestDay}:${QuestId}`

/** Derives a UTC day from Unix milliseconds supplied by the caller's clock or event. */
export function questDayAt(timestamp: number): QuestDay {
  return new Date(timestamp).toISOString().split('T')[0] as QuestDay
}

/** The same quest on another UTC day is a different instance, without a scheduled reset. */
export function questInstanceId(day: QuestDay, questId: QuestId): QuestInstanceId {
  return `${day}:${questId}`
}
