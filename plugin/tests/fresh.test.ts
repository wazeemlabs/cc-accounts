// A move leaves the conversation for the panel to start afresh when nothing
// would wait for that: the extension then runs its whole startup (the
// account and plan it shows, Remote Control, models, commands), which a
// process cca-stream relaunches behind its back never got (2026-11-15: the
// panel kept showing the old account's). cca-stream says it can end for one
// with CCA_STREAM_FRESH, and a process it relaunched has CCA_STREAM_RESUMED.
import { describe, expect, test } from 'claude-code/testing'
import { budgetFile } from '../hooks/budgets'
import { spendDir } from '../hooks/spend'
import { parkedFile } from '../hooks/parking'
import { RECORD, ROOT, SELF, SESSION, SHELL, START, SUPERVISED, SWITCH, cost, endTurn, limits, request, startTurn, turn, world } from './world'

const CAN_END = { ...SUPERVISED, CCA_STREAM_FRESH: '1' }
const RELAUNCHED = { ...CAN_END, CCA_STREAM_RESUMED: '1' }
const SIGINT = ['kill', '-INT', SELF]
const LOOP = { schedule: '*/5 * * * *', recurring: true, prompt: 'check CI' }

describe('a move with nothing to carry on leaves the conversation for the panel to start afresh', () => {
  test('a planned move asks cca-stream to end with the process, and shows the account the panel will start it on', async ($, on) => {
    const w = world(on, CAN_END)
    await $.session.start(START)
    limits(w, 91)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(`2 ${SESSION} fresh\n`)
    expect(w.statuses).toContain('account 2')
    expect(w.killed).toEqual([SIGINT])
  })

  test('a session holding a scheduled wakeup is relaunched, so the wakeup fires without a message', async ($, on) => {
    const w = world(on, CAN_END)
    await $.session.start(START)
    limits(w, 91)
    await turn($, w, [], [LOOP])
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(`2 ${SESSION}\n`)
  })

  test('a Stop hook that said nothing of wakeups is taken as holding some', async ($, on) => {
    const w = world(on, CAN_END)
    await $.session.start(START)
    limits(w, 91)
    const id = await startTurn($)
    w.files.set(RECORD, '{"tasks":[]}\n')
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: id, reason: 'answer' })
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(`2 ${SESSION}\n`)
  })

  test('a move the limit forced carries the work on with its follow-up, relaunched', async ($, on) => {
    const w = world(on, CAN_END)
    await $.session.start(START)
    limits(w, 100)
    await endTurn($, w, await startTurn($))
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(request({ stop: { window: 'five_hour' } }))
  })

  for (const [name, env] of [
    ['a cca-stream that cannot end for it', SUPERVISED],
    ['CCA_REFRESH=off', { ...CAN_END, CCA_REFRESH: 'off' }],
  ] as const) {
    test(`${name}: the move is a relaunch`, async ($, on) => {
      const w = world(on, env)
      await $.session.start(START)
      limits(w, 91)
      await turn($, w, [])
      await w.clock.advance(0)
      expect(w.files.get(SWITCH)).toBe(`2 ${SESSION}\n`)
    })
  }

  test('a session whose tool call was refused, waiting to be woken, is relaunched', async ($, on) => {
    const w = world(on, CAN_END)
    w.files.set(budgetFile(ROOT), '{"/work":1}\n')
    await $.session.start(START)
    // 0.29 points of a 1-point budget at the day's start parks it, and its next call is refused.
    await turn($, w, [], [], cost('claude-opus-5-5', 400_000))
    expect('deny' in (await $.tool.call({ tool: 'Read', file_path: '/x' } as never))).toBe(true)
    expect(w.files.has(parkedFile(ROOT, SESSION))).toBe(true)
    // The turn the refusal was in ends with the account at its leave line.
    limits(w, 91)
    w.files.set(RECORD, '{"tasks":[],"wakeups":0}\n')
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't9', reason: 'answer' })
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(`2 ${SESSION}\n`)
  })
})

describe('a process a move relaunched ends once its turn has carried the work on', () => {
  test('at the end of a turn with nothing left to take over, it asks to start afresh on its own account, once', async ($, on) => {
    const w = world(on, RELAUNCHED)
    await $.session.start(START)
    limits(w, 40)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(`1 ${SESSION} fresh\n`)
    expect(w.killed).toEqual([SIGINT])
    w.files.delete(SWITCH)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.has(SWITCH)).toBe(false)
  })

  test('it waits while background work runs or a wakeup is scheduled, and after a turn that ended on an error', async ($, on) => {
    const w = world(on, RELAUNCHED)
    await $.session.start(START)
    limits(w, 40)
    await turn($, w, [SHELL])
    await turn($, w, [], [LOOP])
    await endTurn($, w, await startTurn($))
    await w.clock.advance(0)
    expect(w.files.has(SWITCH)).toBe(false)
    expect(w.killed).toEqual([])
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(`1 ${SESSION} fresh\n`)
  })

  test('a process the panel started itself never asks', async ($, on) => {
    const w = world(on, CAN_END)
    await $.session.start(START)
    limits(w, 40)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.has(SWITCH)).toBe(false)
  })
})
