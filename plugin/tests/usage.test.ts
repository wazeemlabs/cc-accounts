import { describe, expect, test } from 'claude-code/testing'
import {
  chooseTarget,
  describeUse,
  followUpText,
  formatReading,
  fullWindow,
  windowAtLimit,
  parseReading,
  percentNow,
  readingOf,
  type Candidate,
  type Reading,
} from '../hooks/usage'

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-05T12:00:00Z')
const LATER = '2026-11-05T14:00:00Z'
const EARLIER = '2026-11-05T11:00:00Z'

function reading(account: string, fiveHour: number, weekly = 0, resetsAt = LATER, at = NOW): Reading {
  return readingOf(account, at, [
    { kind: 'five_hour', percentUsed: fiveHour, resetsAt },
    { kind: 'seven_day', percentUsed: weekly, resetsAt: '2026-11-10T00:00:00Z' },
  ])
}

const candidate = (name: string, read: Reading | undefined, sessions = 0): Candidate => ({ name, reading: read, sessions })

describe('readings', () => {
  test('round-trip through the usage file', () => {
    const read = reading('work', 42.5, 10)
    expect(parseReading(formatReading(read))).toEqual(read)
    const noReset = readingOf('work', NOW, [{ kind: 'five_hour', percentUsed: 3 }])
    expect(parseReading(formatReading(noReset))).toEqual(noReset)
  })

  test('refuses a file that is not a reading', () => {
    expect(parseReading('{"account":"work","at":1,"windows":{')).toBe(undefined)
    expect(parseReading('[]')).toBe(undefined)
    expect(parseReading('{"account":"work","windows":{}}')).toBe(undefined)
    expect(parseReading('{"account":"work","at":1,"windows":{"five_hour":{"percentUsed":"9"}}}')).toBe(undefined)
    expect(parseReading('{"account":"work","at":1,"windows":[]}')).toBe(undefined)
  })

  test('a window counts until it resets, then reads as empty', () => {
    expect(percentNow(reading('a', 80), 'five_hour', NOW)).toBe(80)
    expect(percentNow(reading('a', 80, 0, EARLIER), 'five_hour', NOW)).toBe(0)
    expect(percentNow(reading('a', 80, 0, LATER), 'five_hour', Date.parse(LATER))).toBe(0)
  })

  test('a reading with no reset time stops counting a whole window after it was taken', () => {
    const read = readingOf('a', NOW, [{ kind: 'five_hour', percentUsed: 80 }])
    expect(percentNow(read, 'five_hour', NOW + 5 * HOUR - 1)).toBe(80)
    expect(percentNow(read, 'five_hour', NOW + 5 * HOUR)).toBe(0)
  })

  test('a reset time that does not parse falls back to the reading age', () => {
    const read = readingOf('a', NOW, [{ kind: 'five_hour', percentUsed: 80, resetsAt: 'soon' }])
    expect(percentNow(read, 'five_hour', NOW + HOUR)).toBe(80)
    expect(percentNow(read, 'five_hour', NOW + 6 * HOUR)).toBe(0)
  })

  test('no reading, or no such window, is empty', () => {
    expect(percentNow(undefined, 'five_hour', NOW)).toBe(0)
    expect(percentNow(readingOf('a', NOW, []), 'five_hour', NOW)).toBe(0)
  })
})

describe('when a session leaves its account', () => {
  test('at 90% of the five-hour window or 95% of the week, and not below', () => {
    expect(fullWindow(reading('a', 89.9, 94.9), NOW)).toBe(undefined)
    expect(fullWindow(reading('a', 90), NOW)).toBe('five_hour')
    expect(fullWindow(reading('a', 10, 95), NOW)).toBe('seven_day')
    expect(fullWindow(reading('a', 95, 0, EARLIER), NOW)).toBe(undefined)
    expect(fullWindow(undefined, NOW)).toBe(undefined)
  })

  test('a window at 99% or more is the limit itself, and is named', () => {
    expect(windowAtLimit(reading('a', 98.9), NOW)).toBe(undefined)
    expect(windowAtLimit(reading('a', 99), NOW)).toBe('five_hour')
    expect(windowAtLimit(reading('a', 92, 100), NOW)).toBe('seven_day')
  })
})

describe('which account a session moves to', () => {
  test('the one with the most room, never the one it is on', () => {
    const all = [candidate('a', reading('a', 5)), candidate('b', reading('b', 40)), candidate('c', reading('c', 20))]
    expect(chooseTarget('a', all, NOW)).toBe('c')
  })

  test('counts each live session on an account against it, so movers spread out', () => {
    const all = [candidate('b', reading('b', 0), 3), candidate('c', reading('c', 25), 0)]
    expect(chooseTarget('a', all, NOW)).toBe('c')
    expect(chooseTarget('a', [candidate('b', reading('b', 0), 2), candidate('c', reading('c', 25), 0)], NOW)).toBe('b')
  })

  test('takes no account at 70% of five hours or 90% of the week', () => {
    expect(chooseTarget('a', [candidate('b', reading('b', 70))], NOW)).toBe(undefined)
    expect(chooseTarget('a', [candidate('b', reading('b', 10, 90))], NOW)).toBe(undefined)
    expect(chooseTarget('a', [candidate('b', reading('b', 69.9, 89.9))], NOW)).toBe('b')
  })

  test('an account whose window has reset counts as empty', () => {
    expect(chooseTarget('a', [candidate('b', reading('b', 95, 0, EARLIER))], NOW)).toBe('b')
    expect(chooseTarget('a', [candidate('b', undefined), candidate('c', reading('c', 95, 0, EARLIER))], NOW)).toBe('c')
  })

  test('an account nobody has measured is a last resort behind any measured account with room', () => {
    expect(chooseTarget('a', [candidate('b', undefined)], NOW)).toBe('b')
    expect(chooseTarget('a', [candidate('b', undefined), candidate('c', reading('c', 68))], NOW)).toBe('c')
    expect(chooseTarget('a', [candidate('b', undefined), candidate('c', reading('c', 70))], NOW)).toBe('b')
    expect(chooseTarget('a', [candidate('b', undefined, 0), candidate('c', reading('c', 60), 1)], NOW)).toBe('b')
  })

  test('nowhere to go when no other account is listed', () => {
    expect(chooseTarget('a', [], NOW)).toBe(undefined)
    expect(chooseTarget('a', [candidate('a', undefined)], NOW)).toBe(undefined)
  })

  test('ties go to the account listed first', () => {
    expect(chooseTarget('a', [candidate('b', undefined), candidate('c', undefined)], NOW)).toBe('b')
  })
})

describe('what the session is told', () => {
  test('the figure for the status line and /account', () => {
    expect(describeUse(reading('a', 42.4, 7.6), NOW)).toBe('5h 42%, week 8%')
    expect(describeUse(readingOf('a', NOW, [{ kind: 'five_hour', percentUsed: 3, resetsAt: LATER }]), NOW)).toBe('5h 3%')
    expect(describeUse(undefined, NOW)).toBe('')
  })

  test('the follow-up after a limit names both accounts, the window, and any work the move stopped', () => {
    const move = { from: 'a', to: 'b', stopped: [] as string[], crons: [] }
    expect(followUpText({ ...move, limit: 'five_hour' })).toBe(
      '[cc-accounts] The a account reached its 5-hour usage limit and stopped your last turn. ' +
        'This conversation now runs on the b account. Carry on from where you stopped.',
    )
    expect(followUpText({ ...move, limit: 'seven_day', stopped: ['shell "npm test"'] })).toBe(
      '[cc-accounts] The a account reached its weekly usage limit and stopped your last turn. ' +
        'This conversation now runs on the b account. Carry on from where you stopped. ' +
        'The move stopped this background work, so start again whatever of it is still needed: shell "npm test".',
    )
  })

  test('the follow-up hands over the wakeups the move dropped, with or without a limit', () => {
    const loop = { schedule: '*/5 * * * *', recurring: true, prompt: 'check "CI"' }
    const once = { schedule: '30 14 6 11 *', recurring: false, prompt: 'look again' }
    expect(followUpText({ from: 'a', to: 'b', limit: undefined, stopped: [], crons: [loop, once] })).toBe(
      '[cc-accounts] This conversation moved to the b account. The move dropped your scheduled wakeups. ' +
        'Schedule them again: recurring at "*/5 * * * *" with the prompt "check \\"CI\\""; ' +
        'once at "30 14 6 11 *" with the prompt "look again". Nothing else is needed.',
    )
    expect(followUpText({ from: 'a', to: 'b', limit: 'five_hour', stopped: [], crons: [once] })).toBe(
      '[cc-accounts] The a account reached its 5-hour usage limit and stopped your last turn. ' +
        'This conversation now runs on the b account. Carry on from where you stopped. ' +
        'The move dropped your scheduled wakeups. Schedule them again: once at "30 14 6 11 *" with the prompt "look again".',
    )
  })

  test('a move with no limit and no wakeups needs no follow-up', () => {
    expect(followUpText({ from: 'a', to: 'b', limit: undefined, stopped: ['shell "x"'], crons: [] })).toBe(undefined)
  })
})
