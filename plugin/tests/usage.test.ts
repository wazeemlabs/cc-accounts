import { describe, expect, test } from 'claude-code/testing'
import {
  blockMsOf,
  chooseTarget,
  describeUse,
  describeWindows,
  followUpText,
  formatReading,
  fullWindow,
  windowAtLimit,
  parseReading,
  percentNow,
  POLICY,
  readingOf,
  resetsSoon,
  soonerTarget,
  startAccount,
  tightWindow,
  weekEnds,
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

const candidate = (name: string, read: Reading | undefined, load = 0, units = 1): Candidate => ({ name, reading: read, load, units })

// A reading whose week resets `hours` from NOW.
function weekly(account: string, fiveHour: number, hours: number, percent = 50): Reading {
  return readingOf(account, NOW, [
    { kind: 'five_hour', percentUsed: fiveHour, resetsAt: LATER },
    { kind: 'seven_day', percentUsed: percent, resetsAt: new Date(NOW + hours * HOUR).toISOString() },
  ])
}

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
  test('at 90% of the five-hour window or 99% of the week, and not below', () => {
    expect(fullWindow(reading('a', 89.9, 98.9), NOW)).toBe(undefined)
    expect(fullWindow(reading('a', 90), NOW)).toBe('five_hour')
    expect(fullWindow(reading('a', 10, 99), NOW)).toBe('seven_day')
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
    expect(chooseTarget('a', all, NOW, POLICY.take)).toBe('c')
  })

  test('counts each live session on an account against it, so movers spread out', () => {
    const all = [candidate('b', reading('b', 0), 3), candidate('c', reading('c', 25), 0)]
    expect(chooseTarget('a', all, NOW, POLICY.take)).toBe('c')
    expect(chooseTarget('a', [candidate('b', reading('b', 0), 2), candidate('c', reading('c', 25), 0)], NOW, POLICY.take)).toBe('b')
  })

  test('takes no account at 70% of five hours or 97% of the week', () => {
    expect(chooseTarget('a', [candidate('b', reading('b', 70))], NOW, POLICY.take)).toBe(undefined)
    expect(chooseTarget('a', [candidate('b', reading('b', 10, 97))], NOW, POLICY.take)).toBe(undefined)
    expect(chooseTarget('a', [candidate('b', reading('b', 69.9, 96.9))], NOW, POLICY.take)).toBe('b')
  })

  test('an account whose window has reset counts as empty', () => {
    expect(chooseTarget('a', [candidate('b', reading('b', 95, 0, EARLIER))], NOW, POLICY.take)).toBe('b')
    expect(chooseTarget('a', [candidate('b', undefined), candidate('c', reading('c', 95, 0, EARLIER))], NOW, POLICY.take)).toBe('c')
  })

  test('an account nobody has measured is a last resort behind any measured account with room', () => {
    expect(chooseTarget('a', [candidate('b', undefined)], NOW, POLICY.take)).toBe('b')
    expect(chooseTarget('a', [candidate('b', undefined), candidate('c', reading('c', 68))], NOW, POLICY.take)).toBe('c')
    expect(chooseTarget('a', [candidate('b', undefined), candidate('c', reading('c', 70))], NOW, POLICY.take)).toBe('b')
    // A measured account's week has a known reset and is spent before it, whatever the five-hour load.
    expect(chooseTarget('a', [candidate('b', undefined, 0), candidate('c', reading('c', 60), 1)], NOW, POLICY.take)).toBe('c')
  })

  test('load counts each session by its weight, so heavier sessions keep lighter movers away', () => {
    // b holds one session of weight 3, c three of weight 1 and more use.
    expect(chooseTarget('a', [candidate('b', reading('b', 10), 3), candidate('c', reading('c', 15), 1)], NOW, POLICY.take)).toBe('c')
    expect(chooseTarget('a', [candidate('b', reading('b', 10), 0.5), candidate('c', reading('c', 15), 1)], NOW, POLICY.take)).toBe('b')
  })

  test('a bigger plan carries its load more lightly: a Max 20x takes four times the sessions of a Max 5x', () => {
    const all = [candidate('b', reading('b', 20), 4, 4), candidate('c', reading('c', 20), 2, 1)]
    expect(chooseTarget('a', all, NOW, POLICY.take)).toBe('b')
    expect(chooseTarget('a', [candidate('b', reading('b', 20), 4, 1), candidate('c', reading('c', 20), 2, 1)], NOW, POLICY.take)).toBe('c')
  })

  test('a lighter session makes room from 75% of five hours or 95% of the week', () => {
    expect(tightWindow(reading('a', 74.9, 94.9), NOW)).toBe(undefined)
    expect(tightWindow(reading('a', 75), NOW)).toBe('five_hour')
    expect(tightWindow(reading('a', 10, 95), NOW)).toBe('seven_day')
  })

  test('a stopped turn takes any account below the leave line; a planned move only one below the take line', () => {
    const all = [candidate('b', reading('b', 80, 98))]
    expect(chooseTarget('a', all, NOW, POLICY.take)).toBe(undefined)
    expect(chooseTarget('a', all, NOW, POLICY.leave)).toBe('b')
    expect(chooseTarget('a', [candidate('b', reading('b', 90))], NOW, POLICY.leave)).toBe(undefined)
    expect(chooseTarget('a', [candidate('b', reading('b', 10, 99))], NOW, POLICY.leave)).toBe(undefined)
  })

  test('skips an account until its failure record runs out, then takes it again', () => {
    const failed = { ...candidate('b', reading('b', 5)), blockedUntil: NOW + 1 }
    expect(chooseTarget('a', [failed, candidate('c', reading('c', 50))], NOW, POLICY.take)).toBe('c')
    expect(chooseTarget('a', [failed], NOW, POLICY.leave)).toBe(undefined)
    expect(chooseTarget('a', [{ ...failed, blockedUntil: NOW }], NOW, POLICY.take)).toBe('b')
  })

  test('a usage limit keeps sessions off for an hour; a refusal that does not clear on its own, for a day', () => {
    expect(blockMsOf('rate_limit')).toBe(HOUR)
    for (const error of ['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error']) {
      expect(blockMsOf(error)).toBe(24 * HOUR)
    }
  })

  test('nowhere to go when no other account is listed', () => {
    expect(chooseTarget('a', [], NOW, POLICY.take)).toBe(undefined)
    expect(chooseTarget('a', [candidate('a', undefined)], NOW, POLICY.take)).toBe(undefined)
  })

  test('ties go to the account listed first', () => {
    expect(chooseTarget('a', [candidate('b', undefined), candidate('c', undefined)], NOW, POLICY.take)).toBe('b')
  })
})

describe("room is spent before the week that holds it resets", () => {
  test("a week's end is its reset moment, and unknown for an account nobody measured or a week already reset", () => {
    expect(weekEnds(weekly('a', 0, 10), NOW)).toBe(NOW + 10 * HOUR)
    expect(weekEnds(undefined, NOW)).toBe(Infinity)
    expect(weekEnds(readingOf('a', NOW, [{ kind: 'five_hour', percentUsed: 1 }]), NOW)).toBe(Infinity)
    expect(weekEnds(weekly('a', 0, -1), NOW)).toBe(Infinity)
  })

  test('a move takes the account whose week resets first, though another has more five-hour room', () => {
    const all = [candidate('b', weekly('b', 0, 100)), candidate('c', weekly('c', 60, 20)), candidate('d', weekly('d', 10, 50))]
    expect(chooseTarget('a', all, NOW, POLICY.take)).toBe('c')
    // Past the take line it is passed over, for the next week to reset.
    expect(chooseTarget('a', [all[0]!, candidate('c', weekly('c', 60, 20, 97)), all[2]!], NOW, POLICY.take)).toBe('d')
  })

  test('a new session starts on the account whose week resets first; the default wins only among weeks that reset together', () => {
    expect(startAccount('a', [candidate('a', weekly('a', 0, 100)), candidate('b', weekly('b', 40, 20))], NOW)).toBe('b')
    expect(startAccount('a', [candidate('a', weekly('a', 40, 20)), candidate('b', weekly('b', 0, 20))], NOW)).toBe('a')
  })

  test('a session moves to an account whose week resets at least six hours before its own and has room', () => {
    const here = candidate('a', weekly('a', 0, 100))
    expect(soonerTarget(here, [here, candidate('b', weekly('b', 30, 94))], NOW)).toBe('b')
    expect(soonerTarget(here, [here, candidate('b', weekly('b', 30, 94.1))], NOW)).toBe(undefined)
    // Nothing past the take line, and no account whose week has no known reset.
    expect(soonerTarget(here, [here, candidate('b', weekly('b', 70, 20))], NOW)).toBe(undefined)
    expect(soonerTarget(here, [here, candidate('b', weekly('b', 0, 20, 97))], NOW)).toBe(undefined)
    expect(soonerTarget(here, [here, candidate('b', undefined)], NOW)).toBe(undefined)
    expect(soonerTarget(candidate('a', undefined), [candidate('b', undefined)], NOW)).toBe(undefined)
    // A session on an unmeasured account moves to one whose week is known to reset.
    expect(soonerTarget(candidate('a', undefined), [candidate('b', weekly('b', 0, 20))], NOW)).toBe('b')
  })
})

describe('which account a new session starts on', () => {
  test('the default while it has room below the take line', () => {
    const all = [candidate('a', reading('a', 60)), candidate('b', reading('b', 0))]
    expect(startAccount('a', all, NOW)).toBe('a')
    // Unmeasured, it gives way to an account whose week is known to reset; with none measured, it is taken on trust.
    expect(startAccount('a', [candidate('a', undefined), candidate('b', reading('b', 0))], NOW)).toBe('b')
    expect(startAccount('a', [candidate('a', undefined), candidate('b', undefined)], NOW)).toBe('a')
  })

  test('past the take line, the account a planned move would take', () => {
    const all = [candidate('a', reading('a', 80)), candidate('b', reading('b', 40)), candidate('c', reading('c', 10))]
    expect(startAccount('a', all, NOW)).toBe('c')
    expect(startAccount('a', [candidate('a', reading('a', 10, 98)), candidate('b', reading('b', 5))], NOW)).toBe('b')
  })

  test('with none below the take line, the one a stopped turn would take; with none at all, the default', () => {
    expect(startAccount('a', [candidate('a', reading('a', 95)), candidate('b', reading('b', 85))], NOW)).toBe('b')
    expect(startAccount('a', [candidate('a', reading('a', 95)), candidate('b', reading('b', 92))], NOW)).toBe('a')
  })

  test('a default held off after a failure, or not signed in (no candidate), is passed over', () => {
    const held = { ...candidate('a', reading('a', 0)), blockedUntil: NOW + 1 }
    expect(startAccount('a', [held, candidate('b', reading('b', 50))], NOW)).toBe('b')
    expect(startAccount('a', [candidate('b', reading('b', 50))], NOW)).toBe('b')
    expect(startAccount(undefined, [candidate('b', reading('b', 50))], NOW)).toBe('b')
  })
})

describe('a window about to reset', () => {
  const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()
  const resetting = (minutes: number) => readingOf('a', NOW, [{ kind: 'five_hour', percentUsed: 92, resetsAt: at(minutes) }])

  test('resets soon within fifteen minutes, and not once it has reset or further off', () => {
    expect(resetsSoon(resetting(15), 'five_hour', NOW)).toBe(true)
    expect(resetsSoon(resetting(1), 'five_hour', NOW)).toBe(true)
    expect(resetsSoon(resetting(16), 'five_hour', NOW)).toBe(false)
    expect(resetsSoon(resetting(0), 'five_hour', NOW)).toBe(false)
    expect(resetsSoon(readingOf('a', NOW, [{ kind: 'five_hour', percentUsed: 92 }]), 'five_hour', NOW)).toBe(false)
    expect(resetsSoon(undefined, 'five_hour', NOW)).toBe(false)
  })
})

describe('what the session is told', () => {
  test('a log line names each window and its figure in words', () => {
    expect(describeWindows(reading('a', 46.4, 95), NOW)).toBe('5-hour window is at 46% and its weekly window at 95%')
    expect(describeWindows(readingOf('a', NOW, [{ kind: 'seven_day', percentUsed: 12, resetsAt: LATER }]), NOW)).toBe('weekly window is at 12%')
    expect(describeWindows(undefined, NOW)).toBe('usage is not known yet')
  })

  test('the figure for the status line and /account', () => {
    expect(describeUse(reading('a', 42.4, 7.6), NOW)).toBe('5h 42%, week 8%')
    expect(describeUse(readingOf('a', NOW, [{ kind: 'five_hour', percentUsed: 3, resetsAt: LATER }]), NOW)).toBe('5h 3%')
    expect(describeUse(undefined, NOW)).toBe('')
  })

  test('the follow-up after a limit names both accounts, the window, and any work the move stopped', () => {
    const move = { from: 'a', to: 'b', interrupted: false, stopped: [] as string[] }
    expect(followUpText({ ...move, stop: { window: 'five_hour' } })).toBe(
      '[cc-accounts] The a account reached its 5-hour usage limit and stopped your last turn. ' +
        'This conversation now runs on the b account. Carry on from where you stopped.',
    )
    expect(followUpText({ ...move, stop: { window: 'seven_day' }, stopped: ['shell "npm test"'] })).toBe(
      '[cc-accounts] The a account reached its weekly usage limit and stopped your last turn. ' +
        'This conversation now runs on the b account. Carry on from where you stopped. ' +
        'The move stopped this background work, so start again whatever of it is still needed: shell "npm test".',
    )
  })

  test('a turn an account failure stopped is told so, and to carry on', () => {
    const move = { from: 'a', to: 'b', interrupted: false, stopped: [] as string[] }
    expect(followUpText({ ...move, stop: { error: 'rate_limit' } })).toBe(
      '[cc-accounts] The a account reached a usage limit and stopped your last turn. ' +
        'This conversation now runs on the b account. Carry on from where you stopped.',
    )
    expect(followUpText({ ...move, stop: { error: 'authentication_failed' } })).toBe(
      '[cc-accounts] The a account could not serve your last turn (authentication_failed). ' +
        'This conversation now runs on the b account. Carry on from where you stopped.',
    )
  })

  test('a move that cut a turn short tells the conversation to carry on', () => {
    expect(followUpText({ from: 'a', to: 'b', interrupted: true, stop: undefined, stopped: [] })).toBe(
      '[cc-accounts] Moving this conversation to the b account interrupted your turn. Carry on from where you stopped.',
    )
  })

  test('a move with no limit and no cut turn needs no follow-up', () => {
    expect(followUpText({ from: 'a', to: 'b', interrupted: false, stop: undefined, stopped: ['shell "x"'] })).toBe(undefined)
  })
})
