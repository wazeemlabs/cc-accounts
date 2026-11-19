import { describe, expect, test } from 'claude-code/testing'
import { calibrationFile, demandPerHour, demandRate, sessionTokens, spendDir, spendShares, SHARE_MIN_TOKENS } from '../hooks/spend'
import type { EngineInterface } from 'claude-code'
import { ROOT } from './world'
import { POLICY, readingOf, soonerTarget, weekAtRisk, type Candidate, type Reading } from '../hooks/usage'

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-05T12:00:00Z')

// A reading whose week, `weekPercent` used, resets `hours` from NOW.
function weekly(account: string, hours: number, weekPercent: number, fiveHour = 0): Reading {
  return readingOf(account, NOW, [
    { kind: 'five_hour', percentUsed: fiveHour, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
    { kind: 'seven_day', percentUsed: weekPercent, resetsAt: new Date(NOW + hours * HOUR).toISOString() },
  ])
}

const candidate = (name: string, read: Reading | undefined, units = 1): Candidate => ({ name, reading: read, load: 0, units })

describe('whether the room left in a week would expire unused', () => {
  // 80 points left, 40 hours to the reset.
  const soon = candidate('b', weekly('b', 40, 20))
  const here = candidate('a', weekly('a', 100, 0))

  test('it would when the accounts together spend less than twice that room before the reset', () => {
    // 3.9 points an hour for 40 hours is 156, under twice the 80 left.
    expect(weekAtRisk(soon, [here, soon], NOW, 3.9)).toBe(true)
  })

  test('it would not when they spend twice the room or more: sessions leaving full accounts and new ones fill it', () => {
    expect(weekAtRisk(soon, [here, soon], NOW, 4)).toBe(false)
    expect(weekAtRisk(soon, [here, soon], NOW, 40)).toBe(false)
  })

  test('the room of every account whose week ends by then counts, by plan size, and of none that ends later', () => {
    const sooner = candidate('c', weekly('c', 30, 50), 2)
    // 80 + 2 x 50 = 180 points end within 40 hours: 8 an hour is 320, under 360.
    expect(weekAtRisk(soon, [here, soon, sooner], NOW, 8)).toBe(true)
    expect(weekAtRisk(soon, [here, soon, sooner], NOW, 9)).toBe(false)
    // For the earlier week alone: 100 points in 30 hours.
    expect(weekAtRisk(sooner, [here, soon, sooner], NOW, 6.6)).toBe(true)
    expect(weekAtRisk(sooner, [here, soon, sooner], NOW, 6.7)).toBe(false)
  })

  test('an account held off after a failure has no room that can be spent', () => {
    const held = { ...candidate('c', weekly('c', 30, 0)), blockedUntil: NOW + 1 }
    expect(weekAtRisk(soon, [here, soon, held], NOW, 4)).toBe(false)
    expect(weekAtRisk(soon, [here, soon, { ...held, blockedUntil: NOW }], NOW, 4)).toBe(true)
  })

  test('with no record of what the accounts spend, it counts as at risk', () => {
    expect(weekAtRisk(soon, [here, soon], NOW, undefined)).toBe(true)
  })

  test('a full week, or one with no known reset, has nothing to lose', () => {
    expect(weekAtRisk(candidate('b', weekly('b', 40, 100)), [here], NOW, 0)).toBe(false)
    expect(weekAtRisk(candidate('b', undefined), [here], NOW, 0)).toBe(false)
  })
})

describe('a move for a week that resets sooner is made only to save room', () => {
  const here = candidate('a', weekly('a', 100, 0))
  const soon = candidate('b', weekly('b', 40, 20))

  test('it is made when that room would expire, and when nothing is known of the spending', () => {
    expect(soonerTarget(here, [here, soon], NOW, 1, 3.9)).toBe('b')
    expect(soonerTarget(here, [here, soon], NOW, 1)).toBe('b')
  })

  test('it is not made when the week fills anyway: the move would cost a whole uncached context for nothing', () => {
    expect(soonerTarget(here, [here, soon], NOW, 1, 4)).toBe(undefined)
  })

  test('the take line is unchanged by the forecast', () => {
    expect(soonerTarget(here, [here, candidate('b', weekly('b', 40, 20, POLICY.take.five_hour!))], NOW, 1, 0)).toBe(undefined)
  })
})

describe('what the accounts together spend an hour', () => {
  test('the points of the days read, over their hours', () => {
    expect(demandRate(72, 3)).toBe(1)
    expect(demandRate(0, 3)).toBe(0)
  })

  test('nothing read is not known', () => {
    expect(demandRate(undefined, 3)).toBe(undefined)
  })

  test('reads the three whole days before today, each account by its plan size, and not today', async () => {
    const files = new Map<string, string>()
    // The two calls the reader makes.
    const $ = { fs: { exists: async (path: string) => files.has(path), read: async (path: string) => files.get(path)! } } as unknown as EngineInterface
    const DAY = 24 * HOUR
    const at = Date.parse('2026-11-05T12:00:00Z')
    const day = (back: number) => new Date(at - back * DAY).toISOString().slice(0, 10)
    const accounts = [{ name: '1', units: 1 }, { name: '2', units: 2 }]
    expect(await demandPerHour($, ROOT, accounts, at)).toBe(undefined)
    files.set(calibrationFile(ROOT, day(0), '1'), '{"last":90,"consumed":90}\n')
    expect(await demandPerHour($, ROOT, accounts, at)).toBe(undefined)
    files.set(calibrationFile(ROOT, day(1), '1'), '{"last":30,"consumed":30}\n')
    files.set(calibrationFile(ROOT, day(3), '2'), '{"last":21,"consumed":21}\n')
    files.set(calibrationFile(ROOT, day(4), '2'), '{"last":50,"consumed":50}\n')
    // 30 + 2 x 21 = 72 points over 72 hours.
    expect(await demandPerHour($, ROOT, accounts, at)).toBe(1)
  })
})

describe('what each working session spends beside the others', () => {
  const M = SHARE_MIN_TOKENS

  test('a session counts by its spend over the average of the measured ones', () => {
    expect(spendShares(['a', 'b', 'c'], new Map([['a', 6 * M], ['b', 2 * M], ['c', 4 * M]]))).toEqual(new Map([['a', 1.5], ['b', 0.5], ['c', 1]]))
  })

  test('one that has spent too little to judge, or nothing on record, is left out and counts as one', () => {
    expect(spendShares(['a', 'b', 'new', 'none'], new Map([['a', 3 * M], ['b', M], ['new', M - 1]]))).toEqual(new Map([['a', 1.5], ['b', 0.5]]))
  })

  test('with fewer than two measured there is nothing to compare, and every session counts as one', () => {
    expect(spendShares(['a', 'b'], new Map([['a', 50 * M]]))).toEqual(new Map())
    expect(spendShares([], new Map())).toEqual(new Map())
  })

  test('no session counts under a quarter or over four: a day of spend is a rough guide to the next hours', () => {
    const shares = spendShares(['a', 'b', 'c', 'd', 'e', 'f'], new Map([['a', 95 * M], ['b', M], ['c', M], ['d', M], ['e', M], ['f', M]]))
    expect(shares.get('a')).toBe(4)
    expect(shares.get('b')).toBe(0.25)
  })

  test('only the sessions asked about are compared: one that has ended does not move the average', () => {
    expect(spendShares(['a', 'b'], new Map([['a', 3 * M], ['b', M], ['ended', 400 * M]]))).toEqual(new Map([['a', 1.5], ['b', 0.5]]))
  })

  test("a session's spend is read from today and yesterday, every folder it worked in; a client's record is not a session's", async () => {
    const files = new Map<string, string>()
    const $ = {
      fs: {
        exists: async (path: string) => [...files.keys()].some(file => file.startsWith(`${path}/`)),
        list: async (path: string) => [...files.keys()].filter(file => file.startsWith(`${path}/`)).map(file => ({ kind: 'file', name: file.slice(path.length + 1) })),
        read: async (path: string) => files.get(path)!,
      },
    } as unknown as EngineInterface
    const DAY = 24 * HOUR
    const at = Date.parse('2026-11-05T12:00:00Z')
    const day = (back: number) => new Date(at - back * DAY).toISOString().slice(0, 10)
    expect(await sessionTokens($, ROOT, at)).toEqual(new Map())
    files.set(`${spendDir(ROOT, day(0))}/s1.json`, '{"folders":{"/p/a":10,"/p/b":5}}\n')
    files.set(`${spendDir(ROOT, day(1))}/s1.json`, '{"folders":{"/p/a":100}}\n')
    files.set(`${spendDir(ROOT, day(1))}/s2.json`, '{"folders":{"/p/a":7}}\n')
    files.set(`${spendDir(ROOT, day(2))}/s2.json`, '{"folders":{"/p/a":1000}}\n')
    files.set(`${spendDir(ROOT, day(0))}/client.json`, '{"cwd":"/p/a","tokens":900}\n')
    expect(await sessionTokens($, ROOT, at)).toEqual(new Map([['s1', 115], ['s2', 7]]))
  })
})
