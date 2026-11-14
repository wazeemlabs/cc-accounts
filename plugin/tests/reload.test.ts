// A hot reload of the plugin (CLAUDE_CODE_PLUGIN_DIR_WATCH=1) runs register
// and session.start again in the same process. What the switching state
// must keep across it is saved in $.state; the test kit holds $.state for the
// test, so a value set before session.start stands as one an earlier load
// left.
import { describe, expect, test } from 'claude-code/testing'
import { parseSaved, type SavedSwitch } from '../hooks/saved'
import { BY_SESSION, RECORD, SELF, SHELL, START, SUPERVISED, SWITCH, run, turn, world } from './world'

const SIGINT = ['kill', '-INT', SELF]

const saved = (over: Partial<SavedSwitch> = {}): SavedSwitch => ({
  pending: null, tasks: [], turns: 0, answered: null, stranded: null, strandedNote: null, ...over,
})

describe('what a reload keeps', () => {
  test('a queued switch and the work it waits for are saved for the session', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    await turn($, w, [SHELL])
    const { text } = await $.command.run(run('2'))
    expect(text).toMatch(/^Switch to 2 queued/)
    const value = w.state.get('cc-accounts.switching') as SavedSwitch | undefined
    expect(value?.pending).toEqual({ target: '2', force: false, from: '1' })
    expect(value?.tasks).toEqual([SHELL])
  })

  test('a load that finds a queued switch keeps the conversation on its target and carries it out', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.state.set('cc-accounts.switching', saved({ pending: { target: '2', force: false, from: '1' } }))
    w.files.set(BY_SESSION, '2\n')
    await $.session.start(START)
    expect(w.files.get(BY_SESSION)).toBe('2\n')
    expect(w.statuses.at(-1)).toBe('account 1, moving to 2')
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)?.split('\n')[0]).toMatch(/^2 /)
    expect(w.killed).toEqual([SIGINT])
  })

  test('a load that finds background work still waits for it before /account switches', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.state.set('cc-accounts.switching', saved({ tasks: [SHELL] }))
    await $.session.start(START)
    const { text } = await $.command.run(run('2'))
    expect(text).toMatch(/^Switch to 2 queued: waiting for 1 background task \(shell "npm test"\)/)
    await w.clock.advance(0)
    expect(w.killed).toEqual([])
  })

  test('a load in a process that already pruned at its start does not prune every transcript again', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.state.set('cc-accounts.switching', saved())
    await $.session.start(START)
    expect(w.prunes.argv).toEqual([])
  })

  test('a new process finds nothing saved and starts afresh', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.files.set(RECORD, JSON.stringify({ tasks: [SHELL] }))
    await $.session.start(START)
    const { text } = await $.command.run(run('2'))
    expect(text).toMatch(/^Switching to 2/)
  })

  test('a saved value of another shape is dropped, not trusted', () => {
    expect(parseSaved(saved())).toEqual(saved())
    expect(parseSaved(undefined)).toBe(undefined)
    expect(parseSaved({ ...saved(), turns: -1 })).toBe(undefined)
    expect(parseSaved({ ...saved(), tasks: [{ id: 'b1' }] })).toBe(undefined)
    expect(parseSaved({ ...saved(), pending: { target: 2, force: false } })).toBe(undefined)
    expect(parseSaved({ ...saved(), pending: { target: '2', force: false, stop: { other: 1 } } })).toBe(undefined)
  })
})
