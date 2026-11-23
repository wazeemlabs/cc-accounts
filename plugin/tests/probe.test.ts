import { describe, expect, test } from 'claude-code/testing'
import { resumeText, WAIT_MS } from '../hooks/balance'
import { blockFile } from '../hooks/failures'
import { PROBE_MS, probeFile } from '../hooks/probe'
import { formatReading, readingOf } from '../hooks/usage'
import {
  BY_SESSION,
  LATER,
  ROOT,
  SELF,
  START,
  SUPERVISED,
  SWITCH,
  TERMINAL,
  apiError,
  endTurn,
  limits,
  request,
  saved,
  signInThree,
  startTurn,
  turn,
  world,
} from './world'

const SIGINT = ['kill', '-INT', SELF]
const MINUTE = 60_000

// The reading a probe's run saves for `account`: its windows as its reply gave them.
function answer(account: string, at: number, fiveHour: number, weekly: number): string {
  return formatReading(readingOf(account, at, [
    { kind: 'five_hour', percentUsed: fiveHour, resetsAt: LATER },
    { kind: 'seven_day', percentUsed: weekly, resetsAt: LATER },
  ]))
}

// The session's last turn ended on its account's limit.
async function stopAtLimit($: Parameters<typeof endTurn>[0], w: ReturnType<typeof world>): Promise<void> {
  limits(w, 100)
  w.transcript.tail = apiError('rate_limit')
  await endTurn($, w, await startTurn($))
  await w.clock.advance(0)
}

describe('an account that reads full is asked before a session gives up on it', () => {
  // 2026-11-24: an account reset from the account itself read "week 100%"
  // for hours, and every session stayed on spent accounts.
  test('a reset nobody saw is found, and the session moves there', async ($, on) => {
    const w = world(on, SUPERVISED)
    saved(w, '2', 10, 100)
    w.probes.answers.set('2', answer('2', 1, 0, 1))
    await $.session.start(START)
    limits(w, 95)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.probes.asked).toEqual(['2'])
    expect(w.files.get(BY_SESSION)).toBe('2\n')
    expect(w.killed).toEqual([SIGINT])
  })

  test('an account still full stays full, and the session says no account has room', async ($, on) => {
    const w = world(on, SUPERVISED)
    saved(w, '2', 10, 100)
    await $.session.start(START)
    limits(w, 95)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.probes.asked).toEqual(['2'])
    expect(w.files.get(BY_SESSION)).toBe('1\n')
    expect(w.logs.at(-1)).toBe("cc-accounts: 1's 5-hour window is at 95% and its weekly window at 0%, and no other account has room to move to.")
  })

  test('an account is asked once in ten minutes, however many turns end', async ($, on) => {
    const w = world(on, SUPERVISED)
    saved(w, '2', 10, 100)
    await $.session.start(START)
    limits(w, 95)
    await turn($, w, [])
    await turn($, w, [])
    expect(w.probes.asked).toEqual(['2'])
    expect(w.files.get(probeFile(ROOT, '2'))).toBe('0\n')
    await w.clock.advance(PROBE_MS)
    await turn($, w, [])
    expect(w.probes.asked).toEqual(['2', '2'])
  })

  test('a session with room on its own account asks nobody', async ($, on) => {
    const w = world(on, SUPERVISED)
    saved(w, '2', 10, 100)
    await $.session.start(START)
    limits(w, 40)
    await turn($, w, [])
    expect(w.probes.asked).toEqual([])
  })

  test('with room on another account, the full one is not asked', async ($, on) => {
    const w = world(on, SUPERVISED)
    signInThree(w)
    saved(w, '2', 10, 100)
    saved(w, '3', 10, 5)
    await $.session.start(START)
    limits(w, 95)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.probes.asked).toEqual([])
    expect(w.files.get(BY_SESSION)).toBe('3\n')
  })

  test('an account held off after a failure is left to its record, not asked', async ($, on) => {
    const w = world(on, SUPERVISED)
    saved(w, '2', 10, 100)
    w.files.set(blockFile(ROOT, '2', 'account'), `${JSON.stringify({ error: 'authentication_failed', at: 0 })}\n`)
    await $.session.start(START)
    limits(w, 95)
    await turn($, w, [])
    expect(w.probes.asked).toEqual([])
  })

  test('a probe that hangs is reported, and the session stays', async ($, on) => {
    const w = world(on, SUPERVISED)
    saved(w, '2', 10, 100)
    w.probes.fails.add('2')
    await $.session.start(START)
    limits(w, 95)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.logs.some(line => line.startsWith('cc-accounts: could not ask 2 whether it has room ('))).toBe(true)
    expect(w.files.get(BY_SESSION)).toBe('1\n')
    expect(w.killed).toEqual([])
  })
})

describe('a session its account stopped, with nowhere to go, goes on by itself', () => {
  test('once another account has room it moves there and is told to carry on', async ($, on) => {
    const w = world(on, SUPERVISED)
    saved(w, '2', 10, 100)
    await $.session.start(START)
    await stopAtLimit($, w)
    expect(w.files.get(BY_SESSION)).toBe('1\n')
    expect(w.killed).toEqual([])
    // Reset by hand a while later; the next check after the ten minutes finds it.
    w.probes.answers.set('2', answer('2', 2 * WAIT_MS, 0, 1))
    await w.clock.advance(2 * WAIT_MS)
    await w.clock.advance(0)
    expect(w.files.get(BY_SESSION)).toBe('2\n')
    expect(w.files.get(SWITCH)).toBe(request({ stop: { window: 'five_hour' } }))
    expect(w.killed).toEqual([SIGINT])
  })

  test('once its own window has reset it is told to carry on where it is', async ($, on) => {
    const w = world(on, SUPERVISED)
    saved(w, '2', 10, 100)
    await $.session.start(START)
    limits(w, 100, 0, new Date(7 * MINUTE).toISOString())
    w.transcript.tail = apiError('rate_limit')
    await endTurn($, w, await startTurn($))
    await w.clock.advance(WAIT_MS)
    expect(w.submitted).toEqual([])
    await w.clock.advance(WAIT_MS)
    expect(w.submitted).toEqual([resumeText('1', 'five_hour')])
    expect(w.killed).toEqual([])
    expect(w.files.get(BY_SESSION)).toBe('1\n')
  })

  test('its own account reset by hand is found by asking it', async ($, on) => {
    const w = world(on, SUPERVISED)
    saved(w, '2', 10, 100)
    await $.session.start(START)
    await stopAtLimit($, w)
    w.probes.answers.set('1', answer('1', WAIT_MS, 0, 3))
    await w.clock.advance(WAIT_MS)
    expect(w.probes.asked).toContain('1')
    expect(w.submitted).toEqual([resumeText('1', 'five_hour')])
  })

  test('it is told once: the check stops when it goes on', async ($, on) => {
    const w = world(on, SUPERVISED)
    saved(w, '2', 10, 100)
    await $.session.start(START)
    limits(w, 100, 0, new Date(MINUTE).toISOString())
    w.transcript.tail = apiError('rate_limit')
    await endTurn($, w, await startTurn($))
    await w.clock.advance(WAIT_MS)
    await w.clock.advance(3 * WAIT_MS)
    expect(w.submitted).toHaveLength(1)
  })

  test('a turn a person starts ends the wait', async ($, on) => {
    const w = world(on, SUPERVISED)
    saved(w, '2', 10, 100)
    await $.session.start(START)
    await stopAtLimit($, w)
    const asked = w.probes.asked.length
    limits(w, 40)
    await turn($, w, [])
    await w.clock.advance(4 * WAIT_MS)
    expect(w.probes.asked).toHaveLength(asked)
    expect(w.submitted).toEqual([])
  })

  test('a failure of the account is recorded once, however long the session waits', async ($, on) => {
    const w = world(on, SUPERVISED)
    saved(w, '2', 10, 100)
    await $.session.start(START)
    limits(w, 40, 30)
    w.transcript.tail = apiError('rate_limit')
    await endTurn($, w, await startTurn($))
    const first = w.files.get(blockFile(ROOT, '1', 'fable'))
    await w.clock.advance(3 * WAIT_MS)
    expect(w.files.get(blockFile(ROOT, '1', 'fable'))).toBe(first)
    expect(w.submitted).toEqual([])
  })

  test('a print run ends with its turn, and never waits', async ($, on) => {
    const w = world(on, TERMINAL)
    saved(w, '2', 10, 100)
    await $.session.start({ ...START, isInteractive: false })
    await stopAtLimit($, w)
    await w.clock.advance(3 * WAIT_MS)
    expect(w.probes.asked).toEqual([])
    expect(w.submitted).toEqual([])
    expect(w.state.get('cc-accounts.switching')).toMatchObject({ waiting: null })
  })

  test('a reload of the plugin keeps the wait', async ($, on) => {
    const w = world(on, SUPERVISED)
    saved(w, '2', 10, 100)
    w.state.set('cc-accounts.switching', {
      pending: null, tasks: [], turns: 0, answered: null, stranded: null, strandedNote: null, browser: false,
      waiting: { window: 'five_hour' },
    })
    limits(w, 100)
    await $.session.start(START)
    w.probes.answers.set('2', answer('2', WAIT_MS, 0, 1))
    await w.clock.advance(WAIT_MS)
    await w.clock.advance(0)
    expect(w.files.get(BY_SESSION)).toBe('2\n')
  })
})
