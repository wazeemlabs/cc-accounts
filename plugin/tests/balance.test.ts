import { describe, expect, test } from 'claude-code/testing'
import { followUpText, parseReading } from '../hooks/usage'
import {
  BY_SESSION,
  type Cron,
  LATER,
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
  limits,
  request,
  run,
  saved,
  schedule,
  session,
  signInThree,
  startTurn,
  turn,
  world,
} from './world'

const SIGINT = ['kill', '-INT', SELF]
const LOOP: Cron = { schedule: '*/5 * * * *', recurring: true, prompt: 'check CI' }

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

  test('a reading is renamed into place whole, so no session ever reads half of one', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 42)
    await $.session.measure({ context: { window: 200000 }, rateLimits: [...w.limits], changed: ['rateLimits'] } as never)
    expect(w.writes).toContain(`${ROOT}/usage/1.json.${SESSION}.tmp`)
    expect(w.writes).not.toContain(`${ROOT}/usage/1.json`)
    expect([...w.files.keys()].filter(path => path.endsWith('.tmp'))).toEqual([])
    expect(parseReading(w.files.get(`${ROOT}/usage/1.json`) ?? '')?.account).toBe('1')
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
    expect(w.files.get(SWITCH)).toBe(`2 ${SESSION}\n${followUpText({ from: '1', to: '2', interrupted: false, stop: { window: 'five_hour' }, stopped: ['shell "npm test"'] })}\n`)
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
    expect(w.logs.at(-1)).toBe("cc-accounts: 1's 5-hour window is at 95% and its weekly window at 0%, and no other account has room to move to.")
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

describe('a move is carried out once, and the reopened conversation is told what happened', () => {
  test('a move the limit forces ends the process once, though the end of its turn asks for it again', async ($, on) => {
    // requestSwitch schedules one carry-out and turn.complete another; a slow
    // agent list keeps the first waiting while the second starts.
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    const turnId = await startTurn($)
    limits(w, 100)
    w.slow.agentsMs = 1
    const ended = endTurn($, w, turnId)
    await w.clock.advance(1)
    await ended
    await w.clock.advance(5000)
    expect(w.killed).toEqual([SIGINT])
    expect(w.writes.filter(path => path === SWITCH)).toEqual([SWITCH])
  })

  test('a turn the limit stopped reopens with no word on its wakeups, which Claude Code restores on resume', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    const turnId = await startTurn($)
    schedule(w, [LOOP])
    limits(w, 100)
    await endTurn($, w, turnId)
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(request({ stop: { window: 'five_hour' } }))
  })

  test('a turn a queued message starts as the move ends the process is cut, and the conversation is told to carry on', async ($, on) => {
    const w = world(on, SUPERVISED, 2)
    await $.session.start(START)
    limits(w, 91)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.killed).toEqual([SIGINT])
    const cut = await startTurn($)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: cut, reason: 'aborted' })
    await w.clock.advance(3000)
    expect(w.killed).toEqual([SIGINT, SIGINT])
    expect(w.files.get(SWITCH)).toBe(`2 ${SESSION}\n[cc-accounts] Moving this conversation to the 2 account interrupted your turn. Carry on from where you stopped.\n`)
  })

  test('a turn still running when the first SIGINT is answered counts as cut too', async ($, on) => {
    const w = world(on, SUPERVISED, 2)
    await $.session.start(START)
    limits(w, 91)
    await turn($, w, [])
    await w.clock.advance(0)
    await startTurn($)
    await w.clock.advance(3000)
    expect(w.files.get(SWITCH)).toBe(`2 ${SESSION}\n[cc-accounts] Moving this conversation to the 2 account interrupted your turn. Carry on from where you stopped.\n`)
  })

  test('a switch the person forced to stop the work does not ask to carry it on', async ($, on) => {
    const w = world(on, SUPERVISED, 2)
    await $.session.start(START)
    const turnId = await startTurn($)
    await $.command.run(run('2 now'))
    await w.clock.advance(0)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId, reason: 'aborted' })
    await w.clock.advance(3000)
    expect(w.killed).toEqual([SIGINT, SIGINT])
    expect(w.files.get(SWITCH)).toBe(request())
  })

  test('a move never reads the wakeups, so a CronList that refuses changes nothing', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    w.denied.set('CronList', 'not allowed here')
    limits(w, 91)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(request())
    expect(w.logs.filter(line => line.includes('wakeups'))).toEqual([])
  })
})

describe('how the move reopens the conversation', () => {
  test('in a terminal the message rides in the switch file and the session exits', async ($, on) => {
    const w = world(on, TERMINAL)
    await $.session.start(START)
    limits(w, 99.5)
    await endTurn($, w, await startTurn($))
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(`2 ${SESSION}\n${followUpText({ from: '1', to: '2', interrupted: false, stop: { window: 'five_hour' }, stopped: [] })}\n`)
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
    expect(w.logs).toContain("cc-accounts: 1's 5-hour window is at 92% and its weekly window at 100%; moving this conversation to 2.")
    expect(w.files.get(SWITCH)).toBe(`2 ${SESSION}\n${followUpText({ from: '1', to: '2', interrupted: false, stop: { window: 'seven_day' }, stopped: [] })}\n`)
  })

  // Claude Code restores the session's own wakeups when the conversation is
  // resumed (since 2.1.310 at the latest), so a move must not ask for them
  // again: that doubled every wakeup.
  test('a planned move reopens with no message, whatever wakeups the session holds', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 91)
    await turn($, w, [], [LOOP])
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(request())
  })

  test('a VS Code session started before cca-stream moves at the leave line whatever wakeups it holds', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    limits(w, 91)
    await turn($, w, [], [LOOP])
    await w.clock.advance(0)
    expect(w.files.get(BY_SESSION)).toBe('2\n')
    expect(w.killed).toEqual([SIGINT])
  })

  test('a VS Code session started before cca-stream moves when its wakeups cannot be listed', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    w.denied.set('CronList', 'no')
    limits(w, 91)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.killed).toEqual([SIGINT])
  })

  test('/account in a tab opened before cca-stream says nothing of wakeups', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    await turn($, w, [], [LOOP])
    const { text } = await $.command.run(run('2'))
    expect(text).toBe('Switched to 2: your next message continues this conversation on it.')
  })

  test('/account reopens with no message, whatever wakeups the session holds', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    await turn($, w, [], [LOOP])
    await $.command.run(run('2'))
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(request())
  })
})
