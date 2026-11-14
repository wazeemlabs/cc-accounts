import { describe, expect, test, type Engine } from 'claude-code/testing'
import { budgetFile, spendDir } from '../hooks/budgets'
import { parkedFile, WAKE_MS, wakeText } from '../hooks/parking'
import { ROOT, SESSION, START, SUPERVISED, cost, endTurn, run, saved, session, startTurn, turn, world } from './world'

const DAY = 86_400_000
const weights = (value: Record<string, number>) => `${JSON.stringify(value)}\n`
const read = (tool: string) => ({ tool, file_path: '/x' }) as never
const WOKEN = 'cc-accounts: work is within its budget again; this session goes on.'

// This session works in /work on a budget of 1 point a day; a turn of
// 400,000 Opus output tokens (0.29 points) parks it at the day's start, and
// its next tool call is refused.
async function refused($: Engine, w: ReturnType<typeof world>): Promise<void> {
  w.files.set(budgetFile(ROOT), weights({ '/work': 1 }))
  await $.session.start(START)
  await turn($, w, [], [], cost('claude-opus-5-5', 400_000))
  const denied = await $.tool.call(read('Read'))
  expect('deny' in denied).toBe(true)
}

// Session s-600, live in /elsewhere, which is 2 M weighted tokens (0.29
// points) into a budget of 1 point, and was refused there.
function parkedElsewhere(w: ReturnType<typeof world>, budget = 1): void {
  session(w, 600, '2', true, '/elsewhere')
  w.files.set(budgetFile(ROOT), weights({ '/elsewhere': budget, '/work': 100 }))
  w.files.set(`${spendDir(ROOT, '1970-01-01')}/s-600.json`, `${JSON.stringify({ cwd: '/elsewhere', tokens: 2_000_000 })}\n`)
  w.files.set(parkedFile(ROOT, 's-600'), `${JSON.stringify({ folder: '/elsewhere' })}\n`)
}

describe('a parked session is woken once its project is within its budget again', () => {
  test('a refused session records the folder it works in', async ($, on) => {
    const w = world(on, SUPERVISED)
    await refused($, w)
    expect(w.files.get(parkedFile(ROOT, SESSION))).toBe('{"folder":"/work"}\n')
  })

  test('a budget raised in the file is noticed within a minute, and the session told once to carry on', async ($, on) => {
    const w = world(on, SUPERVISED)
    await refused($, w)
    await w.clock.advance(WAKE_MS)
    expect(w.submitted).toEqual([])
    w.files.set(budgetFile(ROOT), weights({ '/work': 100 }))
    await w.clock.advance(WAKE_MS)
    expect(w.submitted).toEqual([wakeText('/work')])
    expect(w.logs).toContain(WOKEN)
    expect(w.statuses.at(-1)).toBe('account 1')
    expect(w.files.has(parkedFile(ROOT, SESSION))).toBe(false)
    await w.clock.advance(10 * WAKE_MS)
    expect(w.submitted).toHaveLength(1)
  })

  test('the allowance catching up wakes it too', async ($, on) => {
    const w = world(on, SUPERVISED)
    await refused($, w)
    // Half a day on, 0.75 points are allowed, past the 0.29 spent.
    await w.clock.advance(DAY / 2)
    expect(w.submitted).toEqual([wakeText('/work')])
  })

  test('/account budget in the parked session itself wakes it at once', async ($, on) => {
    const w = world(on, SUPERVISED)
    await refused($, w)
    await $.command.run(run('budget 100'))
    // The prompt is submitted unawaited, to start once the session is idle.
    await w.clock.settle()
    expect(w.submitted).toEqual([wakeText('/work')])
    await w.clock.advance(WAKE_MS)
    expect(w.submitted).toHaveLength(1)
  })

  test('a session parked at its turn end with nothing refused has nothing to resume and is not prompted', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.files.set(budgetFile(ROOT), weights({ '/work': 1 }))
    await $.session.start(START)
    await turn($, w, [], [], cost('claude-opus-5-5', 400_000))
    w.files.set(budgetFile(ROOT), weights({ '/work': 100 }))
    await w.clock.advance(10 * WAKE_MS)
    expect(w.submitted).toEqual([])
    expect(w.files.has(parkedFile(ROOT, SESSION))).toBe(false)
  })

  test('a session that goes on by itself drops its record, and nothing is sent', async ($, on) => {
    const w = world(on, SUPERVISED)
    await refused($, w)
    // The person writes before the minute's check: the call goes through.
    w.files.set(budgetFile(ROOT), weights({ '/work': 100 }))
    expect(await $.tool.call(read('Read'))).toEqual({ result: undefined, text: '' })
    expect(w.files.has(parkedFile(ROOT, SESSION))).toBe(false)
    await w.clock.advance(10 * WAKE_MS)
    expect(w.submitted).toEqual([])
  })

  test('a budget raised before the turn that was refused has ended still wakes it', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.files.set(budgetFile(ROOT), weights({ '/work': 1 }))
    await $.session.start(START)
    await turn($, w, [], [], cost('claude-opus-5-5', 400_000))
    // The person writes; the turn's first call is refused, and the budget is raised before it ends.
    const turnId = await startTurn($)
    expect('deny' in (await $.tool.call(read('Read')))).toBe(true)
    w.files.set(budgetFile(ROOT), weights({ '/work': 100 }))
    await endTurn($, w, turnId, [])
    await w.clock.advance(WAKE_MS)
    expect(w.submitted).toEqual([wakeText('/work')])
  })

  test('a turn a person starts in a refused session drops its record, which a refusal in it writes again', async ($, on) => {
    const w = world(on, SUPERVISED)
    await refused($, w)
    const turnId = await startTurn($)
    expect(w.files.has(parkedFile(ROOT, SESSION))).toBe(false)
    expect('deny' in (await $.tool.call(read('Read')))).toBe(true)
    expect(w.files.get(parkedFile(ROOT, SESSION))).toBe('{"folder":"/work"}\n')
    await endTurn($, w, turnId, [])
    w.files.set(budgetFile(ROOT), weights({ '/work': 100 }))
    await w.clock.advance(WAKE_MS)
    expect(w.submitted).toEqual([wakeText('/work')])
  })

  test('/account budget wakes a parked session elsewhere at once, and only once', async ($, on) => {
    const w = world(on, SUPERVISED)
    parkedElsewhere(w)
    await $.session.start(START)
    await $.command.run(run('budget 50 /elsewhere'))
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]!.to).toContain('s-600')
    expect(w.sent[0]!.text).toBe(wakeText('/elsewhere'))
    expect(w.files.has(parkedFile(ROOT, 's-600'))).toBe(false)
    await $.command.run(run('budget 60 /elsewhere'))
    expect(w.sent).toHaveLength(1)
  })

  test('/account priority wakes one whose share the new weights cover', async ($, on) => {
    const w = world(on, SUPERVISED)
    saved(w, '2', 10, 50)
    // /elsewhere and /third have no budget and share what the budgets leave by weight.
    session(w, 600, '2', true, '/elsewhere')
    session(w, 700, '2', true, '/third')
    w.files.set(budgetFile(ROOT), weights({ '/work': 1 }))
    w.files.set(`${spendDir(ROOT, '1970-01-01')}/s-600.json`, `${JSON.stringify({ cwd: '/elsewhere', tokens: 8_400_000 })}\n`)
    w.files.set(parkedFile(ROOT, 's-600'), `${JSON.stringify({ folder: '/elsewhere' })}\n`)
    await $.session.start(START)
    await turn($, w, [])
    expect(w.sent).toEqual([])
    await $.command.run(run('priority 3 /elsewhere'))
    expect(w.sent.map(message => message.text)).toEqual([wakeText('/elsewhere')])
  })

  test("any session's turn end wakes a parked one whose own check is gone, as after a reload of the plugin", async ($, on) => {
    const w = world(on, SUPERVISED)
    parkedElsewhere(w)
    await $.session.start(START)
    await turn($, w, [])
    expect(w.sent).toEqual([])
    w.files.set(budgetFile(ROOT), weights({ '/elsewhere': 100, '/work': 100 }))
    await turn($, w, [])
    expect(w.sent.map(message => message.text)).toEqual([wakeText('/elsewhere')])
  })

  // 2026-11-15 review: a reload cancels the module's timers, and nothing
  // started the minute check again, so a session with every other one idle
  // never woke.
  test('a load that finds this session refused starts its minute check again', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.files.set(budgetFile(ROOT), weights({ '/work': 1 }))
    w.files.set(`${spendDir(ROOT, '1970-01-01')}/${SESSION}.json`, `${JSON.stringify({ cwd: '/work', tokens: 2_000_000 })}\n`)
    w.files.set(parkedFile(ROOT, SESSION), `${JSON.stringify({ folder: '/work' })}\n`)
    await $.session.start(START)
    w.files.set(budgetFile(ROOT), weights({ '/work': 100 }))
    await w.clock.advance(WAKE_MS)
    expect(w.submitted).toEqual([wakeText('/work')])
  })

  test('the record of a session that has ended is removed, and nothing is sent', async ($, on) => {
    const w = world(on, SUPERVISED)
    parkedElsewhere(w, 100)
    w.running.delete('600')
    await $.session.start(START)
    await turn($, w, [])
    expect(w.sent).toEqual([])
    expect(w.files.has(parkedFile(ROOT, 's-600'))).toBe(false)
  })

  test("a running session cca did not record is no ended one: its record stays for it", async ($, on) => {
    const w = world(on, SUPERVISED)
    parkedElsewhere(w)
    w.files.delete(`${ROOT}/by-session/s-600`)
    await $.session.start(START)
    await turn($, w, [])
    expect(w.files.has(parkedFile(ROOT, 's-600'))).toBe(true)
  })

  test('a message that reaches nobody keeps the record for the next check, and says so in the debug log', async ($, on) => {
    const w = world(on, SUPERVISED)
    parkedElsewhere(w, 100)
    w.delivery.undeliverable = true
    await $.session.start(START)
    await turn($, w, [])
    expect(w.files.get(parkedFile(ROOT, 's-600'))).toBe('{"folder":"/elsewhere"}\n')
    expect(w.debug).toContain('cc-accounts: could not wake session s-600 (no session by that id is running); the next check tries again.')
    w.delivery.undeliverable = false
    await turn($, w, [])
    expect(w.sent).toHaveLength(1)
  })

  test('a record that is not one is reported and removed', async ($, on) => {
    const w = world(on, SUPERVISED)
    parkedElsewhere(w, 100)
    w.files.set(parkedFile(ROOT, 's-600'), 'nonsense\n')
    await $.session.start(START)
    await turn($, w, [])
    expect(w.sent).toEqual([])
    expect(w.files.has(parkedFile(ROOT, 's-600'))).toBe(false)
    expect(w.logs.some(line => line.startsWith(`cc-accounts: ${parkedFile(ROOT, 's-600')} is not a parked session's record`))).toBe(true)
  })
})
