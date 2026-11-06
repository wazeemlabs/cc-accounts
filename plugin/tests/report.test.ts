import { describe, expect, test } from 'claude-code/testing'
import { formatReport, totals, totalsLine, untilText, type ReportInput } from '../hooks/report'
import type { AccountState } from '../hooks/survey'
import { readingOf } from '../hooks/usage'

const MIN = 60_000
const NOW = Date.parse('2026-11-06T00:00:00Z')
const iso = (minutes: number) => new Date(NOW + minutes * MIN).toISOString()

function state(name: string, fiveHour: number | undefined, week = 0, extra: Partial<AccountState> = {}): AccountState {
  const reading = fiveHour === undefined
    ? undefined
    : readingOf(name, NOW, [
      { kind: 'five_hour', percentUsed: fiveHour, resetsAt: iso(129) },
      { kind: 'seven_day', percentUsed: week, resetsAt: iso(3 * 1440 + 4 * 60) },
    ])
  return { account: { name, dir: `/h/${name}` }, email: `${name}@x.com`, units: 1, sized: true, reading, ...extra }
}

function input(accounts: AccountState[], extra: Partial<ReportInput> = {}): ReportInput {
  return {
    now: NOW,
    accounts: accounts.map(account => ({ state: account, holds: [] })),
    live: [],
    priorities: new Map(),
    current: undefined,
    defaultName: undefined,
    startName: undefined,
    ...extra,
  }
}

describe('/account usage', () => {
  test('says how long until a time, to the minute', () => {
    expect(untilText(NOW + 30_000, NOW)).toBe('under a minute')
    expect(untilText(NOW + 20 * MIN, NOW)).toBe('20m')
    expect(untilText(NOW + 129 * MIN, NOW)).toBe('2h 9m')
    expect(untilText(NOW + (3 * 1440 + 250) * MIN, NOW)).toBe('3d 4h')
  })

  test('adds up free room in Max 5x plans over the accounts that can serve a session now', () => {
    const found = totals({
      ...input([]),
      accounts: [
        { state: state('a', 32, 14), holds: [] },
        { state: state('b', 1, 77, { units: 4 }), holds: [] },
        { state: state('spent', 0, 100), holds: [] },
        { state: state('unread', undefined), holds: [] },
        { state: state('out', 10, 10, { email: undefined }), holds: [] },
        { state: state('held', 10, 10), holds: [{ scope: 'account', until: NOW + MIN }] },
        { state: state('fable-held', 10, 10), holds: [{ scope: 'fable', until: NOW + MIN }] },
      ],
    })
    // A hold on one model family leaves the account serving the others, so it counts.
    expect(found.accounts).toBe(3)
    const cents = (value: number | undefined) => Math.round((value ?? NaN) * 100) / 100
    // a's room, four times b's (a Max 20x) and fable-held's: 0.68 + 3.96 + 0.90 and 0.86 + 0.92 + 0.90;
    // below the leave line 0.58 + 3.56 + 0.80 and 0.81 + 0.72 + 0.85.
    expect([found.free.five_hour, found.free.seven_day, found.beforeMoves.five_hour, found.beforeMoves.seven_day].map(cents))
      .toEqual([5.54, 2.68, 4.94, 2.62])
    expect(totalsLine(found)).toBe('Free now, in Max 5x plans: 5.54 of the 5-hour windows and 2.68 of the weeks, over 3 accounts.')
  })

  test('an account at the limit the balancer goes by (99%) is spent and adds nothing', () => {
    const found = totals({ ...input([]), accounts: [{ state: state('a', 99.4, 10), holds: [] }, { state: state('b', 10, 10), holds: [] }] })
    expect(found.accounts).toBe(1)
    expect(formatReport(input([state('a', 99.4, 10)]))).toContain('a           spent until its 5-hour window resets in 2h 9m')
  })

  test('shows each account, its sessions and holds, the totals and every project by weight', () => {
    const text = formatReport({
      ...input([state('cto', 32, 14), state('levoro', 85, 88), state('docs', 0, 100), state('new', undefined)]),
      accounts: [
        { state: state('cto', 32, 14), holds: [{ scope: 'fable', until: NOW + 45 * MIN }] },
        { state: state('levoro', 85, 88), holds: [] },
        { state: state('docs', 0, 100), holds: [] },
        { state: state('new', undefined, 0, { sized: false }), holds: [] },
      ],
      live: [
        { sessionId: '1', account: 'cto', cwd: '/p/app', name: 'A' },
        { sessionId: '2', account: 'cto', cwd: '/p/misc', name: 'B' },
        { sessionId: '3', account: 'levoro', cwd: '/p/misc/sub', name: 'C' },
      ],
      priorities: new Map([['/p/app', 3]]),
      current: 'cto',
      defaultName: 'levoro',
      startName: 'levoro',
    })
    expect(text.split('\n')).toEqual([
      'account     5-hour free  resets in  week free  resets in   sessions',
      'cto                 68%      2h 9m        86%      3d 4h   2 (load 4), fable held 45m, ← this session',
      'levoro              15%      2h 9m        12%      3d 4h   1, ← new sessions',
      'docs        spent until its weekly window resets in 3d 4h; 0',
      'new         no reading yet; 0, plan size unknown, counted as one Max 5x',
      '',
      'Free now, in Max 5x plans: 0.83 of the 5-hour windows and 0.98 of the weeks, over 2 accounts.',
      'Free before sessions move off (5-hour 90%, week 99%): 0.63 and 0.96.',
      '',
      'project                  priority  sessions   on',
      'app                             3         1   cto',
      'misc                            1         1   cto',
      'sub                             1         1   levoro',
      'Change a weight with /account priority <weight> [folder]; 1 is the default.',
      'No budgets set: every project may spend what the accounts have. Set one with /account budget <points a day> [folder].',
    ])
  })

  test('marks the account new sessions start on, and the default when it is low on room', () => {
    const text = formatReport(input([state('cto', 32, 14), state('levoro', 85, 88)], { defaultName: 'levoro', startName: 'cto' }))
    expect(text).toContain('cto                 68%      2h 9m        86%      3d 4h   0, ← new sessions')
    expect(text).toContain('levoro              15%      2h 9m        12%      3d 4h   0, ← default, low on room')
  })

  test('with no sessions and no weights it says so', () => {
    const lines = formatReport(input([state('a', 10, 10)])).split('\n')
    expect(lines.slice(-3)).toEqual([
      'No live sessions.',
      'Every project counts at 1. Weigh one with /account priority <weight> [folder].',
      'No budgets set: every project may spend what the accounts have. Set one with /account budget <points a day> [folder].',
    ])
  })
})
