import { describe, expect, expectTypeOf, it } from 'vitest'
import { QUESTS } from './catalog'
import { type QuestDay, type QuestInstanceId, questDayAt, questInstanceId } from './quest-day'

describe('UTC quest days', () => {
  it.each([
    ['2026-10-23T00:00:00.000Z', '2026-10-23'],
    ['2026-10-23T12:00:00.000Z', '2026-10-23'],
    ['2026-10-23T23:59:59.999Z', '2026-10-23'],
    ['2026-01-02T03:04:05.000Z', '2026-01-02'],
  ])('assigns %s to quest day %s', (instant, expected) => {
    expect(questDayAt(Date.parse(instant))).toBe(expected)
  })

  it.each([
    ['2026-10-24T00:00:00.000Z', '2026-10-23', '2026-10-24'],
    ['2026-11-01T00:00:00.000Z', '2026-10-31', '2026-11-01'],
    ['2027-01-01T00:00:00.000Z', '2026-12-31', '2027-01-01'],
    ['2028-02-29T00:00:00.000Z', '2028-02-28', '2028-02-29'],
    ['2028-03-01T00:00:00.000Z', '2028-02-29', '2028-03-01'],
    ['2027-03-01T00:00:00.000Z', '2027-02-28', '2027-03-01'],
  ])('changes day exactly at %s', (instant, previousDay, nextDay) => {
    const midnight = Date.parse(instant)
    expect(questDayAt(midnight - 1)).toBe(previousDay)
    expect(questDayAt(midnight)).toBe(nextDay)
    expect(questDayAt(midnight + 1)).toBe(nextDay)
  })

  it.each(['2026-10-24T01:30:00+02:00', '2026-10-23T18:30:00-05:00', '2026-10-23T23:30:00Z'])(
    'uses UTC rather than the calendar date in %s',
    (instant) => {
      expect(questDayAt(Date.parse(instant))).toBe('2026-10-23')
    },
  )

  it('always derives the same day from the same timestamp', () => {
    const timestamp = Date.UTC(2026, 9, 23, 12)
    expect(questDayAt(timestamp)).toBe(questDayAt(timestamp))
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects the invalid timestamp %s with the native date error',
    (timestamp) => {
      expect(() => questDayAt(timestamp)).toThrow(RangeError)
    },
  )

  it('distinguishes a derived quest day from an arbitrary string', () => {
    expectTypeOf(questDayAt(Date.UTC(2026, 9, 23))).toEqualTypeOf<QuestDay>()
    expectTypeOf<QuestDay>().toExtend<string>()
    expectTypeOf<string>().not.toExtend<QuestDay>()
  })
})

describe('Daily quest instance identifiers', () => {
  it('combines the UTC day with the quest identifier', () => {
    const day = questDayAt(Date.UTC(2026, 9, 23))
    expect(questInstanceId(day, 'builder')).toBe('2026-10-23:builder')
    expectTypeOf(questInstanceId(day, 'builder')).toEqualTypeOf<QuestInstanceId>()
  })

  it('assigns a distinct instance to each quest on the same day', () => {
    const day = questDayAt(Date.UTC(2026, 9, 23))
    const ids = QUESTS.map((quest) => questInstanceId(day, quest.id))
    expect(ids).toEqual(['2026-10-23:builder', '2026-10-23:adventurer', '2026-10-23:merchant'])
    expect(new Set(ids).size).toBe(3)
  })

  it('assigns a new instance at midnight without retaining state', () => {
    const midnight = Date.UTC(2026, 9, 24)
    const before = questInstanceId(questDayAt(midnight - 1), 'builder')
    const after = questInstanceId(questDayAt(midnight), 'builder')
    expect(before).toBe('2026-10-23:builder')
    expect(after).toBe('2026-10-24:builder')
  })

  it('always derives the same instance from the same day and quest', () => {
    const day = questDayAt(Date.UTC(2026, 9, 23))
    expect(questInstanceId(day, 'merchant')).toBe(questInstanceId(day, 'merchant'))
  })
})
