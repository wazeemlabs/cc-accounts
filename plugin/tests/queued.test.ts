// A move the balancer queued behind a session's background work can wait for
// hours, and the readings that called for it change meanwhile (2026-11-17: a
// session queued to spend an account's week before it reset kept waiting
// past the reset, and would still have moved). At each turn's end the
// balancer decides again: a move still called for keeps waiting, one that now
// fits another account better goes there, and one nothing calls for any more
// is dropped. A move a person asked for with /account is theirs and is never
// second-guessed.
import { describe, expect, test } from 'claude-code/testing'
import {
  BY_SESSION,
  HOME,
  SELF,
  SESSION,
  SHELL,
  START,
  SUPERVISED,
  SWITCH,
  limits,
  request,
  run,
  saved,
  session,
  signInThree,
  turn,
  world,
} from './world'

const SIGINT = ['kill', '-INT', SELF]
const HOUR = 3_600_000
// Account 2's week resets seven hours in: well before 1's, so a session on 1
// queues a move to spend it.
const SEVEN_HOURS = new Date(7 * HOUR).toISOString()
const MOVING = 'account 1, moving to 2'

type W = ReturnType<typeof world>

// This session in the session registry, as Claude Code lists it, so that it
// counts on whichever account the balancer takes it to be on.
function registerSelf(w: W): void {
  w.files.set(`${HOME}/.claude-shared/sessions/${SELF}.json`, JSON.stringify({ pid: Number(SELF), sessionId: SESSION, cwd: '/work', name: '' }))
  w.running.add(SELF)
}

describe('a move the balancer queued is decided again at each turn end', () => {
  test('a move still called for keeps waiting, told once', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 10, 20)
    saved(w, '2', 10, 50, SEVEN_HOURS)
    await turn($, w, [SHELL])
    await turn($, w, [SHELL])
    await w.clock.advance(0)
    expect(w.killed).toEqual([])
    expect(w.files.get(BY_SESSION)).toBe('2\n')
    expect(w.statuses.at(-1)).toBe(MOVING)
    expect(w.logs.filter(line => line.includes('moving this conversation to 2'))).toHaveLength(1)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(request())
    expect(w.killed).toEqual([SIGINT])
  })

  test('a move to spend a week that has since reset is dropped, and the session stays', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 10, 20)
    saved(w, '2', 10, 50, SEVEN_HOURS)
    await turn($, w, [SHELL])
    expect(w.statuses.at(-1)).toBe(MOVING)
    await w.clock.advance(8 * HOUR)
    await turn($, w, [SHELL])
    expect(w.files.get(BY_SESSION)).toBe('1\n')
    expect(w.statuses.at(-1)).toBe('account 1 · 5h 10%, week 20%')
    expect(w.logs.at(-1)).toBe('cc-accounts: nothing calls for the move to 2 any more; this conversation stays on 1.')
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.has(SWITCH)).toBe(false)
    expect(w.killed).toEqual([])
  })

  test('a move whose target has since filled is dropped where no other account has room', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 10, 20)
    saved(w, '2', 10, 50, SEVEN_HOURS)
    await turn($, w, [SHELL])
    saved(w, '2', 10, 97, SEVEN_HOURS)
    await turn($, w, [SHELL])
    expect(w.files.get(BY_SESSION)).toBe('1\n')
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.killed).toEqual([])
  })

  test('a move whose target has since filled goes to an account that has room now', async ($, on) => {
    const w = world(on, SUPERVISED)
    signInThree(w)
    await $.session.start(START)
    limits(w, 10, 20)
    saved(w, '2', 10, 50, SEVEN_HOURS)
    saved(w, '3', 10, 97, SEVEN_HOURS)
    await turn($, w, [SHELL])
    expect(w.statuses.at(-1)).toBe(MOVING)
    saved(w, '2', 10, 97, SEVEN_HOURS)
    saved(w, '3', 10, 50, SEVEN_HOURS)
    await turn($, w, [SHELL])
    expect(w.files.get(BY_SESSION)).toBe('3\n')
    expect(w.statuses.at(-1)).toBe('account 1, moving to 3')
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)?.split('\n')[0]).toBe(`3 ${SESSION}`)
    expect(w.killed).toEqual([SIGINT])
  })

  test('the session counts on the account it runs on, not the one it is queued for', async ($, on) => {
    const w = world(on, SUPERVISED)
    registerSelf(w)
    await $.session.start(START)
    limits(w, 40, 20)
    saved(w, '2', 10, 20)
    for (const pid of [101, 102, 103, 104]) session(w, pid, '1')
    await turn($, w, [SHELL])
    expect(w.statuses.at(-1)).toBe(MOVING)
    await turn($, w, [SHELL])
    expect(w.files.get(BY_SESSION)).toBe('2\n')
    expect(w.statuses.at(-1)).toBe(MOVING)
  })

  test('a switch the person asked for is never dropped, though nothing on the account calls for it', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    await turn($, w, [SHELL])
    await $.command.run(run('2'))
    await turn($, w, [SHELL])
    await w.clock.advance(0)
    expect(w.files.get(BY_SESSION)).toBe('2\n')
    expect(w.killed).toEqual([])
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.killed).toEqual([SIGINT])
  })

  test('a switch the person asked for is not moved elsewhere by the balancer', async ($, on) => {
    const w = world(on, SUPERVISED)
    signInThree(w)
    await $.session.start(START)
    limits(w, 10, 20)
    saved(w, '3', 10, 50, SEVEN_HOURS)
    await turn($, w, [SHELL])
    await $.command.run(run('2'))
    await turn($, w, [SHELL])
    expect(w.files.get(BY_SESSION)).toBe('2\n')
  })
})

describe('what a reload keeps of who asked for a queued move', () => {
  test("a balancer's queued move saved before a reload is still decided again after it", async ($, on) => {
    const w = world(on, SUPERVISED)
    w.state.set('cc-accounts.switching', {
      pending: { target: '2', force: false, from: '1', by: 'balancer' }, tasks: [SHELL], turns: 0, answered: null, stranded: null, strandedNote: null,
    })
    w.files.set(BY_SESSION, '2\n')
    await $.session.start(START)
    limits(w, 10, 20)
    await turn($, w, [SHELL])
    expect(w.files.get(BY_SESSION)).toBe('1\n')
    expect(w.logs.at(-1)).toBe('cc-accounts: nothing calls for the move to 2 any more; this conversation stays on 1.')
  })

  test('a queued move an older plugin saved, with no word of who asked, is kept as a person\'s', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.state.set('cc-accounts.switching', {
      pending: { target: '2', force: false, from: '1' }, tasks: [SHELL], turns: 0, answered: null, stranded: null, strandedNote: null,
    })
    w.files.set(BY_SESSION, '2\n')
    await $.session.start(START)
    limits(w, 10, 20)
    await turn($, w, [SHELL])
    expect(w.files.get(BY_SESSION)).toBe('2\n')
    expect(w.statuses.at(-1)).toBe(MOVING)
  })
})
