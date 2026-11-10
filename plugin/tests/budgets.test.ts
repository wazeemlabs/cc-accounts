import { describe, expect, test } from 'claude-code/testing'
import {
  budgetFile,
  budgetLines,
  calibrated,
  calibrationFile,
  dailySupplyOf,
  dayEnd,
  dayOf,
  daysBack,
  DEFAULT_TOKENS_PER_POINT,
  formatBudgets,
  over,
  parkedText,
  parseBudget,
  parseBudgets,
  parseCalibration,
  parseSpend,
  plan,
  projectOf,
  spendDir,
  weightedTokens,
  type Spend,
} from '../hooks/budgets'
import type { AccountState, LiveSession } from '../hooks/survey'
import { readingOf } from '../hooks/usage'
import { BY_SESSION, ROOT, SESSION, START, SUPERVISED, cost, run, saved, session, turn, world } from './world'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-07T06:00:00Z')
const iso = (at: number) => new Date(at).toISOString()

function account(name: string, week: number | undefined, resetsAt = NOW + 2 * DAY, extra: Partial<AccountState> = {}): AccountState {
  const reading = week === undefined
    ? undefined
    : readingOf(name, NOW, [{ kind: 'five_hour', percentUsed: 10, resetsAt: iso(NOW + 3_600_000) }, { kind: 'seven_day', percentUsed: week, resetsAt: iso(resetsAt) }])
  return { account: { name, dir: `/h/${name}` }, email: `${name}@x.com`, units: 1, sized: true, reading, ...extra }
}

const live = (sessionId: string, cwd: string): LiveSession => ({ sessionId, account: 'a', cwd, name: '', active: true })
const spent = (cwd: string, tokens: number): Spend => ({ cwd, tokens })
const cents = (value: number | undefined) => Math.round((value ?? NaN) * 100) / 100

describe('budgets', () => {
  test('a budget is a number of points a day above 0 and at most 10000', () => {
    expect(parseBudget('35')).toBe(35)
    expect(parseBudget('12.5')).toBe(12.5)
    for (const bad of ['0', '-1', '10001', '1e2', 'ten', '', '.5']) expect(parseBudget(bad)).toBe(undefined)
  })

  test('the file round-trips, and anything but absolute folders with points in range is refused', () => {
    const budgets = new Map([['/p/studio', 35], ['/p/legal', 12.5]])
    expect(parseBudgets(formatBudgets(budgets))).toEqual(budgets)
    for (const bad of ['[]', '{"rel": 2}', '{"/a": 0}', '{"/a": "2"}', '{"/a":', 'null']) expect(parseBudgets(bad)).toBe(undefined)
  })

  test('days are UTC, and a window of days ends today', () => {
    expect(dayOf(NOW)).toBe('2026-11-07')
    expect(dayEnd(NOW)).toBe(Date.parse('2026-11-08T00:00:00Z'))
    expect(daysBack(NOW, 3)).toEqual(['2026-11-07', '2026-11-06', '2026-11-05'])
  })

  test('a session belongs to the nearest budgeted folder, else the nearest weighted one, else its own', () => {
    const budgets = new Map([['/p/studio', 35]])
    const priorities = new Map([['/p/legal', 3]])
    expect(projectOf(budgets, priorities, '/p/studio/channel')).toBe('/p/studio')
    expect(projectOf(budgets, priorities, '/p/legal/backend')).toBe('/p/legal')
    expect(projectOf(budgets, priorities, '/p/other')).toBe('/p/other')
  })

  test('tokens weigh by kind and by model family', () => {
    const counts = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 40 }
    // 100 + 0.1 × 1000 + 1.25 × 40 + 5 × 10 = 300
    expect(weightedTokens({ model: 'claude-opus-5-5', ...counts })).toBe(300)
    expect(weightedTokens({ model: 'claude-fable-5-1', ...counts })).toBe(600)
    expect(cents(weightedTokens({ model: 'claude-sonnet-5-5', ...counts }))).toBe(cents(180))
    expect(weightedTokens({ model: 'something-else', ...counts })).toBe(300)
  })

  test("a client's record from cca spend is weighed per model as a session's turns are", () => {
    const counts = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 40 }
    const record = JSON.stringify({ cwd: '/work', account: 'cto', usage: { 'claude-opus-5-5': counts, 'claude-sonnet-5-5': counts } })
    // 300 for Opus, 0.6 × 300 for Sonnet.
    expect(cents(parseSpend(record)!.tokens)).toBe(cents(480))
    expect(parseSpend(record)!.cwd).toBe('/work')
    expect(parseSpend('{"cwd":"/work","tokens":7}')).toEqual({ cwd: '/work', tokens: 7 })
  })

  test('a client record with a missing, negative or non-numeric count is not read', () => {
    const counts = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 }
    expect(parseSpend(JSON.stringify({ cwd: '/work', usage: { m: { ...counts, output_tokens: -1 } } }))).toBeUndefined()
    expect(parseSpend(JSON.stringify({ cwd: '/work', usage: { m: { ...counts, input_tokens: '1' } } }))).toBeUndefined()
    const { cache_read_input_tokens: _dropped, ...missing } = counts
    expect(parseSpend(JSON.stringify({ cwd: '/work', usage: { m: missing } }))).toBeUndefined()
    expect(parseSpend(JSON.stringify({ cwd: '/work', usage: { m: 3 } }))).toBeUndefined()
    expect(parseSpend(JSON.stringify({ cwd: '/work' }))).toBeUndefined()
    // A client's record names the account it called.
    expect(parseSpend(JSON.stringify({ cwd: '/work', usage: { m: counts } }))).toBeUndefined()
  })

  test("a day's calibration sums the rises between readings and counts a new week from zero", () => {
    const week = '2026-11-11T00:00:00.000Z'
    const first = calibrated(undefined, 40, week)
    expect(first).toEqual({ last: 40, consumed: 0, resetsAt: week })
    const second = calibrated(first, 43.5, week)
    expect(second).toEqual({ last: 43.5, consumed: 3.5, resetsAt: week })
    const next = '2026-11-18T00:00:00.000Z'
    expect(calibrated(second, 2, next)).toEqual({ last: 2, consumed: 5.5, resetsAt: next })
  })

  test("a lower reading of the same week adds nothing, and the next rise counts from the highest", () => {
    const week = '2026-11-11T00:00:00.000Z'
    // A session's older view (39 after 40) is not a reset.
    const stale = calibrated({ last: 40, consumed: 9, resetsAt: week }, 39, week)
    expect(stale).toEqual({ last: 40, consumed: 9, resetsAt: week })
    expect(calibrated(stale, 41, week)).toEqual({ last: 41, consumed: 10, resetsAt: week })
    // A reset moment drifting by seconds is the same week.
    expect(calibrated(stale, 38, '2026-11-11T00:00:05.000Z')).toEqual({ last: 40, consumed: 9, resetsAt: week })
  })

  test('a lower reading with no reset moment on either side is taken as the same week', () => {
    expect(calibrated({ last: 40, consumed: 9 }, 39)).toEqual({ last: 40, consumed: 9 })
    expect(calibrated({ last: 40, consumed: 9 }, 42)).toEqual({ last: 42, consumed: 11 })
    expect(calibrated({ last: 40, consumed: 9 }, 3, '2026-11-18T00:00:00.000Z')).toEqual({ last: 40, consumed: 9, resetsAt: '2026-11-18T00:00:00.000Z' })
  })

  test('a calibration record with a reset moment that is not text is refused', () => {
    expect(parseCalibration('{"last":40,"consumed":9,"resetsAt":"2026-11-11T00:00:00.000Z"}')).toEqual({ last: 40, consumed: 9, resetsAt: '2026-11-11T00:00:00.000Z' })
    expect(parseCalibration('{"last":40,"consumed":9,"resetsAt":5}')).toBeUndefined()
    expect(parseCalibration('{"last":40,"consumed":9}')).toEqual({ last: 40, consumed: 9 })
  })

  test("an account's daily supply spreads its room until its week resets", () => {
    // 49 points of room, two days to the reset: 24.5 a day.
    expect(cents(dailySupplyOf(account('a', 50), NOW))).toBe(cents(24.5))
    // A reset in 12 hours: the whole 49, plus half a day of a fresh week.
    expect(cents(dailySupplyOf(account('a', 50, NOW + DAY / 2), NOW))).toBe(cents(49 + 99 / 14))
    // No reading yet: a steady seventh of a week; a Max 20x four times that; a spent account nothing.
    expect(cents(dailySupplyOf(account('a', undefined), NOW))).toBe(cents(99 / 7))
    expect(cents(dailySupplyOf(account('a', undefined, NOW, { units: 4 }), NOW))).toBe(cents(4 * 99 / 7))
    expect(dailySupplyOf(account('a', 99), NOW)).toBe(0)
    expect(dailySupplyOf(account('a', 50, NOW, { email: undefined }), NOW)).toBe(0)
  })

  test('a budgeted project gets its budget and the rest share what is left by weight, each paced through the day', () => {
    const budgets = new Map([['/p/studio', 35]])
    const priorities = new Map([['/p/legal', 3]])
    const accounts = [account('a', undefined), account('b', undefined), account('c', undefined), account('d', undefined), account('e', undefined)]
    const found = plan(
      NOW,
      accounts,
      [live('1', '/p/studio/x'), live('2', '/p/legal/y'), live('3', '/p/legal/z'), live('4', '/p/misc')],
      new Map([['1', spent('/p/studio/x', 14e6)], ['2', spent('/p/legal/y', 140e6)]]),
      budgets,
      priorities,
      DEFAULT_TOKENS_PER_POINT,
    )
    expect(cents(found.supply)).toBe(cents(5 * 99 / 7))
    const by = Object.fromEntries(found.projects.map(project => [project.folder, project]))
    expect(by['/p/studio']!.allowance).toBe(35)
    expect(by['/p/studio']!.budgeted).toBe(true)
    expect(cents(by['/p/studio']!.spent)).toBe(cents(2))
    expect(by['/p/studio']!.sessions).toBe(1)
    // 35.71 left, shared 3:1 between legal and misc.
    const left = 5 * 99 / 7 - 35
    expect(cents(by['/p/legal']!.allowance)).toBe(cents(left * 0.75))
    expect(cents(by['/p/legal']!.spent)).toBe(cents(20))
    expect(by['/p/legal']!.sessions).toBe(2)
    expect(cents(by['/p/misc']!.allowance)).toBe(cents(left * 0.25))
    // Six hours into the day, a quarter day ahead: half the allowance.
    expect(cents(by['/p/studio']!.allowedNow)).toBe(cents(17.5))
    expect(over(found, budgets, priorities, '/p/legal/y')).toBe(by['/p/legal'])
    expect(over(found, budgets, priorities, '/p/studio/x')).toBe(undefined)
    expect(over(found, budgets, priorities, '/p/none')).toBe(undefined)
  })

  test('a parked project is told its figures and when the day turns', () => {
    const budgets = new Map([['/p/legal', 10]])
    const found = plan(NOW, [account('a', undefined)], [live('1', '/p/legal')], new Map([['1', spent('/p/legal', 70e6)]]), budgets, new Map(), DEFAULT_TOKENS_PER_POINT)
    const project = over(found, budgets, new Map(), '/p/legal')!
    expect(parkedText(project, found, NOW)).toBe(
      'cc-accounts: legal has spent 10 of the 10 points its sessions may use today (5 by now). This session is parked until the ' +
        'allowance catches up or the UTC day turns in 18h 0m. Stop here; do not retry.',
    )
    expect(budgetLines(found, '/p/legal', NOW)).toEqual([
      'Budgets, in points (1% of a Max 5x week) per UTC day; the accounts supply about 14.1 today, and a point is about 7.0 M weighted tokens. The day turns in 18h 0m.',
      'project                    a day   spent  by now  sessions   ',
      'legal                         10      10       5         1   set, over: parked, ← this project',
    ])
  })
})

const weights = (value: Record<string, number>) => `${JSON.stringify(value)}\n`
const read = (tool: string) => ({ tool, file_path: '/x' }) as never

// This session started in /work (START.cwd); the world's clock starts at 0, the first UTC day.
describe('a session over its budget is parked between turns', () => {
  test("a turn's cost is added to the session's spend for the day", async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    await turn($, w, [], [], cost('claude-opus-5-5', 1000))
    const file = `${spendDir(ROOT, '1970-01-01')}/${SESSION}.json`
    expect(w.files.get(file)).toBe('{"cwd":"/work","tokens":5000}\n')
    await turn($, w, [], [], cost('claude-fable-5-1', 100))
    expect(w.files.get(file)).toBe('{"cwd":"/work","tokens":6000}\n')
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'a1', reason: 'answer', agentId: 'a', usage: cost('claude-opus-5-5', 200) })
    expect(w.files.get(file)).toBe('{"cwd":"/work","tokens":7000}\n')
    await w.clock.advance(DAY)
    await turn($, w, [], [], cost('claude-opus-5-5', 1))
    expect(w.files.get(`${spendDir(ROOT, '1970-01-02')}/${SESSION}.json`)).toBe('{"cwd":"/work","tokens":5}\n')
  })

  test('a reading of the week is added to the day\'s calibration', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    w.limits.push({ kind: 'five_hour', percentUsed: 10 }, { kind: 'seven_day', percentUsed: 40 })
    await $.session.measure({ context: { window: 200000 }, rateLimits: [...w.limits], changed: ['rateLimits'] } as never)
    w.limits[1]!.percentUsed = 42
    await $.session.measure({ context: { window: 200000 }, rateLimits: [...w.limits], changed: ['rateLimits'] } as never)
    expect(w.files.get(calibrationFile(ROOT, '1970-01-01', '1'))).toBe('{"last":42,"consumed":2}\n')
  })

  test("a session's older view of the same week, reported after a newer one, adds nothing to the day's calibration", async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    const week = '2026-11-11T00:00:00.000Z'
    w.limits.push({ kind: 'five_hour', percentUsed: 10 }, { kind: 'seven_day', percentUsed: 0, resetsAt: week })
    const measure = async (percent: number): Promise<void> => {
      w.limits[1]!.percentUsed = percent
      await $.session.measure({ context: { window: 200000 }, rateLimits: [...w.limits], changed: ['rateLimits'] } as never)
    }
    await measure(31)
    await measure(40)
    await measure(39)
    await measure(40)
    expect(w.files.get(calibrationFile(ROOT, '1970-01-01', '1'))).toBe(`{"last":40,"consumed":9,"resetsAt":"${week}"}\n`)
  })

  test("a point's size counts a client's tokens only on a day its account was measured", async ($, on) => {
    const w = world(on, SUPERVISED)
    const day = spendDir(ROOT, '1970-01-01')
    const client = (account: string, output: number): string =>
      `${JSON.stringify({ cwd: '/work', account, usage: { 'claude-opus-5-5': { input_tokens: 0, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}\n`
    w.files.set(calibrationFile(ROOT, '1970-01-01', '1'), '{"last":30,"consumed":10}\n')
    w.files.set(`${day}/${SESSION}.json`, '{"cwd":"/work","tokens":70000000}\n')
    // 7 M weighted on account 1, which sessions measured; 50 M on account 2, which nothing measured.
    w.files.set(`${day}/client-1-abc.json`, client('1', 1_400_000))
    w.files.set(`${day}/client-2-abc.json`, client('2', 10_000_000))
    w.files.set(budgetFile(ROOT), weights({ '/work': 100 }))
    await $.session.start(START)
    // (70 + 7) M over 10 points; counting account 2's 50 M would make it 12.7 M.
    const shown = (await $.command.run(run('budget'))).text ?? ''
    expect(shown).toContain('a point is about 7.7 M weighted tokens')
  })

  test('past its allowance so far, its tool calls are refused once the turn ends, and taken again when the allowance catches up', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.files.set(budgetFile(ROOT), weights({ '/work': 1 }))
    await $.session.start(START)
    // Mid-turn, nothing is refused, whatever was spent.
    await $.turn.start({ text: 'go', turnId: 't1' })
    expect(await $.tool.call(read('Read'))).toEqual({ result: undefined, text: '' })
    // 400,000 output tokens on Opus: 2 M weighted, 0.29 points, past the quarter point allowed at the day's start.
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: cost('claude-opus-5-5', 400_000) })
    expect(w.logs.at(-1)).toBe(
      'cc-accounts: work has spent 0.3 of the 1 points its sessions may use today (0.3 by now). This session is parked until the ' +
        'allowance catches up or the UTC day turns in 24h 0m. Stop here; do not retry.',
    )
    expect(w.statuses.at(-1)).toBe('account 1 · parked: work over budget')
    const refused = await $.tool.call(read('Read'))
    expect('deny' in refused && refused.deny?.startsWith('cc-accounts: work has spent 0.3 of the 1 points')).toBe(true)
    // Half a day on, 0.75 points are allowed: the next call goes through.
    await w.clock.advance(DAY / 2)
    expect(await $.tool.call(read('Read'))).toEqual({ result: undefined, text: '' })
    expect(w.logs.at(-1)).toBe('cc-accounts: work is within its budget again; this session goes on.')
    expect(w.statuses.at(-1)).toBe('account 1')
  })

  test("a client's spend from cca spend counts against its project's budget and parks the project's sessions", async ($, on) => {
    const w = world(on, SUPERVISED)
    w.files.set(budgetFile(ROOT), weights({ '/work': 1 }))
    // 400,000 output tokens on Opus through a bridge: 0.29 points, past the quarter point allowed at the day's start.
    const counts = { input_tokens: 0, output_tokens: 400_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    w.files.set(`${spendDir(ROOT, '1970-01-01')}/client-1-abc.json`, `${JSON.stringify({ cwd: '/work', account: '1', usage: { 'claude-opus-5-5': counts } })}\n`)
    await $.session.start(START)
    await turn($, w, [], [], cost('claude-opus-5-5', 1))
    const refused = await $.tool.call(read('Read'))
    expect('deny' in refused && refused.deny?.startsWith('cc-accounts: work has spent 0.3 of the 1 points')).toBe(true)
  })

  test('with no budget set, nothing is parked', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    await turn($, w, [], [], cost('claude-opus-5-5', 400_000))
    expect(await $.tool.call(read('Read'))).toEqual({ result: undefined, text: '' })
    expect(w.logs.some(line => line.includes('parked'))).toBe(false)
  })

  test('CCA_BUDGET=off leaves every session running', async ($, on) => {
    const w = world(on, { ...SUPERVISED, CCA_BUDGET: 'off' })
    w.files.set(budgetFile(ROOT), weights({ '/work': 1 }))
    await $.session.start(START)
    await turn($, w, [], [], cost('claude-opus-5-5', 400_000))
    expect(await $.tool.call(read('Read'))).toEqual({ result: undefined, text: '' })
    expect(w.logs.some(line => line.includes('parked'))).toBe(false)
  })

  test('another project\'s spend counts against its own budget, not this one\'s', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.files.set(budgetFile(ROOT), weights({ '/work': 1, '/other': 1 }))
    w.files.set(`${spendDir(ROOT, '1970-01-01')}/s-11.json`, '{"cwd":"/other","tokens":70000000}\n')
    session(w, 11, '1', true, '/other')
    await $.session.start(START)
    await turn($, w, [], [], cost('claude-opus-5-5', 1))
    expect(await $.tool.call(read('Read'))).toEqual({ result: undefined, text: '' })
  })

  test('/account budget sets, removes and shows budgets', async ($, on) => {
    const w = world(on, SUPERVISED)
    saved(w, '2', 10, 50)
    session(w, 500, '1', true, '/work')
    await $.session.start(START)
    expect((await $.command.run(run('budget'))).text).toBe(
      'No budgets set: every project may spend what the accounts have. Set one with /account budget <points a day> [folder].',
    )
    expect((await $.command.run(run('budget ten'))).text).toBe('A budget is a number of points a day above 0 and at most 10000, such as 35; 0 removes it.')
    expect((await $.command.run(run('budget 35 ~/studio'))).text).toBe(
      'studio (/Users/me/studio) may spend 35 points a day, and so may the folders inside it that have no budget of their own. ' +
        'Projects with no budget share what the accounts supply beyond the budgets set, by their weights.',
    )
    expect(w.files.get(budgetFile(ROOT))).toBe('{\n  "/Users/me/studio": 35\n}\n')
    const shown = ((await $.command.run(run('budget'))).text ?? '').split('\n')
    expect(shown.slice(1)).toEqual([
      'project                    a day   spent  by now  sessions   ',
      'studio                        35       0     8.8         0   set',
      // The two accounts supply about 14 points today, all of it spoken for by studio's budget: nothing is left to share.
      'work                           0       0       0         1   share of the rest, over: parked, ← this project',
    ])
    expect((await $.command.run(run('budget 0 ~/studio'))).text).toBe(
      'studio (/Users/me/studio) has no budget of its own: it shares what is left after the budgets set.',
    )
    expect(w.files.get(budgetFile(ROOT))).toBe('{}\n')
    expect(w.files.get(BY_SESSION)).toBe('1\n')
  })
})
