// A move keeps the session's model and effort (keep.ts): the plugin writes
// them beside the switch request, and cca or cca-stream starts the new
// process with them. 2026-11-14: a session on Fable 5.2 came back on Opus 5.5
// after a move, and an effort set for the session alone was lost too.
import { describe, expect, test } from 'claude-code/testing'
import { effortIn } from '../hooks/keep'
import { SELF, SHELL, START, SUPERVISED, SWITCH, TERMINAL, limits, run, turn, world } from './world'

const KEPT = `${SWITCH}.keep`
const SIGINT = ['kill', '-INT', SELF]

function request(effort: unknown, querySource = 'sdk'): string {
  return JSON.stringify({ type: 'api-request', querySource, params: { model: 'claude-fable-5-2', output_config: { effort } } })
}

describe('what a move keeps', () => {
  test("the session's model and the effort of its last request are left beside the switch request", async ($, on) => {
    const w = world(on, SUPERVISED)
    w.model.value = 'claude-fable-5-2[1m]'
    w.transcript.tail = `${request('xhigh')}\n`
    await $.session.start(START)
    limits(w, 91)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.get(KEPT)).toBe('model claude-fable-5-2[1m]\neffort xhigh\n')
    expect(w.killed).toEqual([SIGINT])
  })

  test('a terminal session keeps them too, and a switch the person asked for', async ($, on) => {
    const w = world(on, TERMINAL)
    w.transcript.tail = `${request('low', 'repl_main_thread')}\n`
    await $.session.start(START)
    await $.command.run(run('2'))
    await w.clock.advance(0)
    expect(w.files.get(KEPT)).toBe('model claude-opus-5-5\neffort low\n')
    expect(w.ran).toContain('exit')
  })

  test('what cannot be read is left out, said, and the move still goes', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.model.fails = true
    w.transcript.tail = null
    await $.session.start(START)
    await $.command.run(run('2'))
    await w.clock.advance(0)
    expect(w.files.get(KEPT)).toBe('')
    expect(w.logs.some(line => line.includes("could not read this session's model"))).toBe(true)
    expect(w.logs.some(line => line.includes("could not read this session's effort"))).toBe(true)
    expect(w.killed).toEqual([SIGINT])
  })

  test('a model that is no model id is not passed on', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.model.value = 'opus --dangerously-skip-permissions'
    await $.session.start(START)
    await $.command.run(run('2'))
    await w.clock.advance(0)
    expect(w.files.get(KEPT)).toBe('')
  })

  test('a switch that cannot end the process is withdrawn with what it kept', async ($, on) => {
    const w = world(on, SUPERVISED, Infinity)
    await $.session.start(START)
    await $.command.run(run('2'))
    await w.clock.advance(10000)
    expect(w.files.has(SWITCH)).toBe(false)
    expect(w.files.has(KEPT)).toBe(false)
  })

  test('a queued switch keeps what the session runs on when it goes, not when it was asked for', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    await turn($, w, [SHELL])
    await $.command.run(run('2'))
    w.model.value = 'claude-sonnet-5-5'
    w.transcript.tail = `${request('medium')}\n`
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.get(KEPT)).toBe('model claude-sonnet-5-5\neffort medium\n')
  })
})

describe("the effort of a session's last main-loop request", () => {
  test('the last main-loop request counts', () => {
    expect(effortIn(`${request('low')}\n${request('high')}\n`)).toBe('high')
  })

  test("a subagent's or a title's request does not", () => {
    expect(effortIn(`${request('high')}\n${request('low', 'agent:general-purpose')}\n`)).toBe('high')
  })

  test('a level --effort does not take, or none, keeps nothing', () => {
    expect(effortIn(`${request('auto')}\n`)).toBe(undefined)
    expect(effortIn(`${request(undefined)}\n`)).toBe(undefined)
    expect(effortIn('')).toBe(undefined)
  })

  test('a row cut by the read or not JSON is passed over', () => {
    expect(effortIn(`${request('max')}\n{"type":"api-req\nnot json\n[1]\nnull\n`)).toBe('max')
  })
})
