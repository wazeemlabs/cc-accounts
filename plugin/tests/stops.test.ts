import { describe, expect, test } from 'claude-code/testing'
import { blockFile } from '../hooks/failures'
import {
  BY_SESSION,
  ROOT,
  SELF,
  START,
  SUPERVISED,
  SWITCH,
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
const HOUR = 3_600_000

describe('a turn the account stopped moves, whatever the readings show', () => {
  test("a per-model limit the readings do not show moves the session at once and tells it to carry on", async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 40, 30)
    w.transcript.tail = apiError('rate_limit')
    await endTurn($, w, await startTurn($))
    await w.clock.advance(0)
    expect(w.files.get(BY_SESSION)).toBe('2\n')
    expect(w.files.get(SWITCH)).toBe(request({ stop: { error: 'rate_limit' } }))
    expect(w.killed).toEqual([SIGINT])
    expect(JSON.parse(w.files.get(blockFile(ROOT, '1')) ?? '{}')).toEqual({ error: 'rate_limit', at: 0 })
    expect(w.logs).toContain('cc-accounts: 1 failed the last turn (rate_limit); moving this conversation to 2.')
  })

  test('an account that lost its login moves the session though it has no reading yet', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    w.transcript.tail = apiError('authentication_failed')
    await endTurn($, w, await startTurn($))
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(request({ stop: { error: 'authentication_failed' } }))
  })

  test("an error that is not the account's (overloaded) moves nothing below the leave line", async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 50)
    w.transcript.tail = apiError('overloaded')
    await endTurn($, w, await startTurn($))
    await w.clock.advance(0)
    expect(w.killed).toEqual([])
    expect(w.files.has(blockFile(ROOT, '1'))).toBe(false)
  })

  test('a transcript that cannot be read leaves the readings to decide, and says so', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 100)
    w.transcript.tail = null
    await endTurn($, w, await startTurn($))
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(request({ stop: { window: 'five_hour' } }))
    expect(w.logs).toContain('cc-accounts: could not read why the last turn failed (tail: No such file or directory).')
  })
})

describe('where a stopped session goes', () => {
  test('any account below the leave line beats staying stopped', async ($, on) => {
    const w = world(on, SUPERVISED)
    saved(w, '2', 80)
    await $.session.start(START)
    limits(w, 100)
    await endTurn($, w, await startTurn($))
    await w.clock.advance(0)
    expect(w.files.get(BY_SESSION)).toBe('2\n')
  })

  test('but a planned move does not take an account above the take line', async ($, on) => {
    const w = world(on, SUPERVISED)
    saved(w, '2', 80)
    await $.session.start(START)
    limits(w, 92)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.killed).toEqual([])
  })

  test('an account that failed a call within the hour is skipped, so sessions do not bounce between two', async ($, on) => {
    const w = world(on, SUPERVISED)
    signInThree(w)
    w.files.set(blockFile(ROOT, '2'), `${JSON.stringify({ error: 'rate_limit', at: 0 })}\n`)
    await w.clock.advance(HOUR - 1)
    await $.session.start(START)
    w.transcript.tail = apiError('rate_limit')
    await endTurn($, w, await startTurn($))
    await w.clock.advance(0)
    expect(w.files.get(BY_SESSION)).toBe('3\n')
  })

  test('with every other account failing too, the session stays and says why', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.files.set(blockFile(ROOT, '2'), `${JSON.stringify({ error: 'rate_limit', at: 0 })}\n`)
    await $.session.start(START)
    w.transcript.tail = apiError('rate_limit')
    await endTurn($, w, await startTurn($))
    await w.clock.advance(0)
    expect(w.killed).toEqual([])
    expect(w.logs).toContain('cc-accounts: 1 failed the last turn (rate_limit), and no other account has room to move to.')
  })

  test('a failure record that is not one is reported and the account counts as working', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.files.set(blockFile(ROOT, '2'), '{"error":')
    await $.session.start(START)
    limits(w, 100)
    await endTurn($, w, await startTurn($))
    await w.clock.advance(0)
    expect(w.files.get(BY_SESSION)).toBe('2\n')
    expect(w.logs.some(line => line.startsWith(`cc-accounts: ${blockFile(ROOT, '2')} is not a failure record`))).toBe(true)
  })
})

describe('a window about to reset', () => {
  const soon = (minutes: number) => new Date(minutes * 60_000).toISOString()

  test('a planned move waits out a window that resets within fifteen minutes', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 92, 0, soon(10))
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.killed).toEqual([])
    expect(w.logs.at(-1)).toBe("cc-accounts: 1's 5-hour window is at 5h 92%, week 0% but resets within 15 minutes; staying.")
  })

  test('one further off moves as before', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 92, 0, soon(20))
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.killed).toEqual([SIGINT])
  })

  test('a turn the limit stopped moves however soon the window resets', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    limits(w, 100, 0, soon(5))
    await endTurn($, w, await startTurn($))
    await w.clock.advance(0)
    expect(w.killed).toEqual([SIGINT])
  })
})
