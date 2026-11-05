import { describe, expect, test } from 'claude-code/testing'
import type { Cron } from '../hooks/background'
import { followUpText, formatReading, parseReading, readingOf } from '../hooks/usage'
import {
  BY_SESSION,
  HOME,
  ROOT,
  SELF,
  SESSION,
  SHELL,
  START,
  STREAM,
  SUPERVISED,
  SWITCH,
  TERMINAL,
  endTurn,
  run,
  startTurn,
  turn,
  world,
} from './world'

const SIGINT = ['kill', '-INT', SELF]
const LATER = '2100-01-01T00:00:00Z'
const SESSIONS = `${HOME}/.claude-shared/sessions`
const LOOP: Cron = { schedule: '*/5 * * * *', recurring: true, prompt: 'check CI' }

type World = ReturnType<typeof world>

// The session's own account (1) reports these windows.
function limits(w: World, fiveHour: number, weekly = 0): void {
  w.limits.splice(0, w.limits.length,
    { kind: 'five_hour', percentUsed: fiveHour, resetsAt: LATER },
    { kind: 'seven_day', percentUsed: weekly, resetsAt: LATER })
}

// Another account's reading, as one of its sessions saved it.
function saved(w: World, account: string, fiveHour: number): void {
  const reading = readingOf(account, 0, [{ kind: 'five_hour', percentUsed: fiveHour, resetsAt: LATER }])
  w.files.set(`${ROOT}/usage/${account}.json`, formatReading(reading))
}

function signInThree(w: World): void {
  w.files.set(`${HOME}/.claude-three/.claude.json`, '{"oauthAccount":{"emailAddress":"three@example.com"}}')
}

// Another live (or ended) session on `account`.
function session(w: World, pid: number, account: string, live = true): void {
  w.files.set(`${SESSIONS}/${pid}.json`, JSON.stringify({ pid, sessionId: `s-${pid}`, cwd: '/x' }))
  w.files.set(`${ROOT}/by-session/s-${pid}`, `${account}\n`)
  if (live) w.running.add(String(pid))
}

describe('every session saves its account usage', () => {
  test('a measurement that moved the rate limits is saved for the other sessions and shown in the status line', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 42.4, 7)
    await $.session.measure({ context: { window: 200000 }, rateLimits: [...w.limits], changed: ['rateLimits'] } as never)
    const reading = parseReading(w.files.get(`${ROOT}/usage/1.json`) ?? '')
    expect(reading?.windows.five_hour).toEqual({ percentUsed: 42.4, resetsAt: LATER })
    expect(w.statuses.at(-1)).toBe('account 1 · 5h 42%, week 7%')
  })

  test('a measurement of the context alone writes nothing', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 42)
    await $.session.measure({ context: { window: 200000 }, rateLimits: [...w.limits], changed: ['context'] } as never)
    expect(w.files.has(`${ROOT}/usage/1.json`)).toBe(false)
  })
})

describe('a session leaves an account that is nearly spent', () => {
  test('below 90% it stays', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 89)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.killed).toEqual([])
    expect(w.files.get(BY_SESSION)).toBe('1\n')
  })

  test('at 90% it moves, once the turn is over, to the account with room, and reopens in the same tab', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 91)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.get(BY_SESSION)).toBe('2\n')
    expect(w.files.get(SWITCH)).toBe(`2 ${SESSION}\n`)
    expect(w.killed).toEqual([SIGINT])
  })

  test('a move at 90% waits for the background work, as /account does', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 91)
    await turn($, w, [SHELL])
    await w.clock.advance(0)
    expect(w.killed).toEqual([])
    expect(w.statuses.at(-1)).toBe('account 1, moving to 2')
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.killed).toEqual([SIGINT])
  })

  test('a turn the limit stopped moves at once, stopping the work, and reopens with a message that names it', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    await turn($, w, [SHELL])
    limits(w, 100)
    await endTurn($, w, await startTurn($))
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(`2 ${SESSION}\n${followUpText({ from: '1', to: '2', limit: 'five_hour', stopped: ['shell "npm test"'], crons: [] })}\n`)
    expect(w.killed).toEqual([SIGINT])
  })

  test('the weekly window at 95% moves it too', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 10, 96)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.get(BY_SESSION)).toBe('2\n')
  })

  test('an account with live sessions counts against it, so sessions leaving together spread out', async ($, on) => {
    const w = world(on, SUPERVISED)
    signInThree(w)
    saved(w, '3', 25)
    session(w, 11, '2')
    session(w, 12, '2')
    session(w, 13, '2')
    session(w, 14, '3', false)
    await $.session.start(START)
    limits(w, 92)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.get(BY_SESSION)).toBe('3\n')
  })

  test('it never moves to an account that is not signed in', async ($, on) => {
    const w = world(on, SUPERVISED)
    saved(w, '2', 75)
    await $.session.start(START)
    limits(w, 95)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.killed).toEqual([])
    expect(w.files.get(BY_SESSION)).toBe('1\n')
    expect(w.logs.at(-1)).toBe('cc-accounts: 1 is at 5h 95%, week 0%, and no other account has room to move to.')
  })

  test('CCA_BALANCE=off keeps every session where it is', async ($, on) => {
    const w = world(on, { ...SUPERVISED, CCA_BALANCE: 'off' })
    await $.session.start(START)
    limits(w, 100)
    await endTurn($, w, await startTurn($))
    await w.clock.advance(0)
    expect(w.killed).toEqual([])
  })

  test('a switch the person asked for is not replaced', async ($, on) => {
    const w = world(on, SUPERVISED)
    signInThree(w)
    saved(w, '2', 60)
    await $.session.start(START)
    const turnId = await startTurn($)
    await $.command.run(run('2'))
    limits(w, 95)
    await endTurn($, w, turnId, [])
    await w.clock.advance(0)
    expect(w.files.get(BY_SESSION)).toBe('2\n')
    expect(w.files.get(SWITCH)).toBe(`2 ${SESSION}\n`)
  })

  test('a subagent turn ending moves nothing', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 100)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'sub', reason: 'error', agentId: 'a1' })
    await w.clock.advance(0)
    expect(w.killed).toEqual([])
  })
})

describe('how the move reopens the conversation', () => {
  test('in a terminal the message rides in the switch file and the session exits', async ($, on) => {
    const w = world(on, TERMINAL)
    await $.session.start(START)
    limits(w, 99.5)
    await endTurn($, w, await startTurn($))
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(`2 ${SESSION}\n${followUpText({ from: '1', to: '2', limit: 'five_hour', stopped: [], crons: [] })}\n`)
    expect(w.ran).toEqual(['exit'])
  })

  test('a VS Code session started before cca-stream ends its process with no switch file', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    limits(w, 95)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.get(BY_SESSION)).toBe('2\n')
    expect(w.files.has(SWITCH)).toBe(false)
    expect(w.killed).toEqual([SIGINT])
  })

  test('a session cca did not start, which nothing would reopen, stays', async ($, on) => {
    const w = world(on, { CLAUDE_ACCOUNT: '1' })
    await $.session.start(START)
    limits(w, 95)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.get(BY_SESSION)).toBe('1\n')
    expect(w.killed).toEqual([])
  })

  test('a terminal -p run stays, so a script never comes back as an interactive session', async ($, on) => {
    const w = world(on, TERMINAL)
    await $.session.start({ ...START, surface: null, isInteractive: false })
    limits(w, 100)
    await endTurn($, w, await startTurn($))
    await w.clock.advance(0)
    expect(w.files.get(BY_SESSION)).toBe('1\n')
    expect(w.ran).toEqual([])
  })

  test('says why it moved', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 92, 100)
    await endTurn($, w, await startTurn($))
    await w.clock.advance(0)
    expect(w.logs).toContain("cc-accounts: 1's weekly window is at 5h 92%, week 100%; moving this conversation to 2.")
    expect(w.files.get(SWITCH)).toBe(`2 ${SESSION}\n${followUpText({ from: '1', to: '2', limit: 'seven_day', stopped: [], crons: [] })}\n`)
  })

  test('a move hands the reopened conversation the wakeups it dropped', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 91)
    await turn($, w, [], [LOOP])
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(
      `2 ${SESSION}\n${followUpText({ from: '1', to: '2', limit: undefined, stopped: [], crons: [LOOP] })}\n`,
    )
  })

  test('a VS Code session started before cca-stream keeps its wakeups until the limit forces a move', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    limits(w, 91)
    await turn($, w, [], [LOOP])
    await w.clock.advance(0)
    expect(w.killed).toEqual([])
    limits(w, 100)
    await endTurn($, w, await startTurn($))
    await w.clock.advance(0)
    expect(w.killed).toEqual([SIGINT])
  })

  test('/account also hands over the wakeups it drops', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    await turn($, w, [], [LOOP])
    await $.command.run(run('2'))
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(
      `2 ${SESSION}\n${followUpText({ from: '1', to: '2', limit: undefined, stopped: [], crons: [LOOP] })}\n`,
    )
  })
})
