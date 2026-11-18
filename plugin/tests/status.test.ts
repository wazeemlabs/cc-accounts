import { describe, expect, test } from 'claude-code/testing'
import { START, SUPERVISED, limits, run, startTurn, world } from './world'

describe('the status line', () => {
  test("the status line shows how full the context window is once a response reported it, beside the account's use", async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    w.window.percent = 62
    await $.session.measure({ context: { ...w.window }, rateLimits: [], changed: ['context'] } as never)
    expect(w.statuses.at(-1)).toBe('account 1 · context 62%')
    limits(w, 42)
    w.window.percent = 63
    await $.session.measure({ context: { ...w.window }, rateLimits: [...w.limits], changed: ['rateLimits', 'context'] } as never)
    expect(w.statuses.at(-1)).toBe('account 1 · 5h 42%, week 0% · context 63%')
    // Just compacted: no figure until the next response.
    delete w.window.percent
    await $.session.measure({ context: { ...w.window }, rateLimits: [...w.limits], changed: ['context'] } as never)
    expect(w.statuses.at(-1)).toBe('account 1 · 5h 42%, week 0%')
  })

  test('a context measurement leaves the line of a switch under way', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    await startTurn($)
    await $.command.run(run('2'))
    const line = w.statuses.at(-1)
    w.window.percent = 62
    await $.session.measure({ context: { ...w.window }, rateLimits: [], changed: ['context'] } as never)
    expect(w.statuses.at(-1)).toBe(line)
  })
})
