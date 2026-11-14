// Budget and parking edges the 2026-11-15 review found: each test states
// the contract the README promises.
import { describe, expect, test } from 'claude-code/testing'
import { budgetFile, calibrated, calibrationFile, parseBudgets, projectOf, spendDir } from '../hooks/budgets'
import { parkedFile, WAKE_MS, wakeText } from '../hooks/parking'
import { parsePriorities } from '../hooks/priorities'
import { DESKTOP, HOME, ROOT, SESSION, START, SUPERVISED, cost, run, session, turn, world } from './world'

const DAY = 86_400_000
const weights = (value: Record<string, number>) => `${JSON.stringify(value)}\n`
const read = (tool: string) => ({ tool, file_path: '/x' }) as never

describe('calibration', () => {
  test("an older session's view of last week, reported after this week's first reading, adds nothing", () => {
    const thisWeek = '2026-11-18T00:00:00.000Z'
    const lastWeek = '2026-11-11T00:00:00.000Z'
    // The week reset at 00:00; a session measured 1% of the new week.
    const before = { last: 1, consumed: 1, resetsAt: thisWeek }
    // Another session's response from just before the reset lands after it: 95% of last week.
    const after = calibrated(before, 95, lastWeek)
    expect(after.consumed).toBe(1)
  })
})

describe('folders', () => {
  test('a folder written in budgets.json or priorities.json by hand, with a trailing or doubled slash, holds its folder', () => {
    const budgets = parseBudgets('{"/work/": 10}')!
    expect(projectOf(budgets, new Map(), '/work')).toBe('/work')
    expect(parsePriorities('{"/a//b/": 2}')).toEqual(new Map([['/a/b', 2]]))
  })
})

describe('the README command for the folderless default', () => {
  test('/account budget with the quoted scratch folder, as the README writes it, sets that folder', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.files.set(budgetFile(ROOT), weights({ '/work': 10 }))
    await $.session.start(START)
    const text = (await $.command.run(run('budget 2 "~/Library/Application Support/Claude/scratch-workspaces"'))).text ?? ''
    expect(text).not.toContain('Name the folder as a full path')
    expect(w.files.get(budgetFile(ROOT))).toContain('scratch-workspaces')
  })
})

describe('spend follows the folder it was spent in', () => {
  test("a session that moves to another project does not carry the day's earlier spend there", async ($, on) => {
    const w = world(on, SUPERVISED)
    w.files.set(budgetFile(ROOT), weights({ '/a': 100, '/b': 1 }))
    await $.session.start({ ...START, cwd: '/a' })
    // 2 M weighted tokens (0.29 points) spent in /a.
    await turn($, w, [], [], cost('claude-opus-5-5', 400_000))
    // /cd to /b; one small turn there.
    w.where.root = '/b'
    await turn($, w, [], [], cost('claude-opus-5-5', 1))
    // /b spent 5 tokens; it is within its 1-point budget and must not be parked.
    expect(await $.tool.call(read('Read'))).toEqual({ result: undefined, text: '' })
  })
})

describe('a session cca records no account for', () => {
  test('a desktop session on a login cca does not hold is not parked as a project with no share', async ($, on) => {
    const w = world(on, { ...DESKTOP, CLAUDE_CODE_ACCOUNT_UUID: 'uuid-other' })
    // It is running, in the session list like any session.
    w.files.set(`${HOME}/.claude-shared/sessions/500.json`, JSON.stringify({ pid: 500, sessionId: SESSION, cwd: '/work', name: '' }))
    w.running.add('500')
    // Two signed-in accounts supply about 28 points; budgets take 1 + 5 (scratch).
    w.files.set(budgetFile(ROOT), weights({ '/other': 1 }))
    await $.session.start(START)
    await turn($, w, [], [], cost('claude-opus-5-5', 1000))
    expect(await $.tool.call(read('Read'))).toEqual({ result: undefined, text: '' })
  })

  test("its tokens stay out of a point's size, as a client's on an unmeasured account do", async ($, on) => {
    const w = world(on, { ...DESKTOP, CLAUDE_CODE_ACCOUNT_UUID: 'uuid-other' })
    const day = spendDir(ROOT, '1970-01-01')
    w.files.set(calibrationFile(ROOT, '1970-01-01', '1'), '{"last":30,"consumed":10}\n')
    w.files.set(`${day}/s-1.json`, '{"cwd":"/work","tokens":70000000}\n')
    w.files.set(budgetFile(ROOT), weights({ '/work': 100 }))
    await $.session.start(START)
    // 500 M weighted tokens on a login no cca account holds: no points are measured beside them.
    await turn($, w, [], [], cost('claude-opus-5-5', 100_000_000))
    const shown = (await $.command.run(run('budget'))).text ?? ''
    expect(shown).toContain('a point is about 7.0 M weighted tokens')
  })
})

describe('waking', () => {
  test('a parked session whose session-list entry is caught mid-write keeps its record', async ($, on) => {
    const w = world(on, SUPERVISED)
    session(w, 600, '2', true, '/elsewhere')
    w.files.set(budgetFile(ROOT), weights({ '/elsewhere': 1, '/work': 100 }))
    w.files.set(`${spendDir(ROOT, '1970-01-01')}/s-600.json`, `${JSON.stringify({ cwd: '/elsewhere', tokens: 2_000_000 })}\n`)
    w.files.set(parkedFile(ROOT, 's-600'), `${JSON.stringify({ folder: '/elsewhere' })}\n`)
    await $.session.start(START)
    // Claude Code is rewriting s-600's entry (status busy/idle) at the moment this session reads it.
    w.files.set(`${HOME}/.claude-shared/sessions/600.json`, '{"pid":600,"sessi')
    await turn($, w, [])
    expect(w.files.has(parkedFile(ROOT, 's-600'))).toBe(true)
  })
})

describe('herd', () => {
  test('a sliver of headroom wakes one parked session of a project, not all of them', async ($, on) => {
    const w = world(on, SUPERVISED)
    // /elsewhere: 1 point a day; 0.2499 points spent; three of its sessions parked at 0.25 allowed.
    w.files.set(budgetFile(ROOT), weights({ '/elsewhere': 1, '/work': 100 }))
    for (const pid of [600, 601, 602]) {
      session(w, pid, '2', true, '/elsewhere')
      w.files.set(parkedFile(ROOT, `s-${pid}`), `${JSON.stringify({ folder: '/elsewhere' })}\n`)
    }
    w.files.set(`${spendDir(ROOT, '1970-01-01')}/s-600.json`, `${JSON.stringify({ cwd: '/elsewhere', tokens: 0.2499 * 7_000_000 })}\n`)
    await $.session.start(START)
    await turn($, w, [])
    // Each woken session runs a whole turn unchecked (its first call clears parked.project).
    expect(w.sent.length).toBe(1)
  })
})

