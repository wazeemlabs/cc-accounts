import { describe, expect, test } from 'claude-code/testing'
import { describeTasks, isWatch, parseRecord, taskStarted, turnMark, working } from '../hooks/background'
import {
  BY_SESSION,
  RECORD,
  SCOUT,
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
// As Claude Code lists a watch it keeps on a published artifact.
const WATCH = { id: 'm1', type: 'monitor', description: 'live updates for artifact https://claude.ai/code/artifact/296dbf74-961a-42d3-9fef-ae149277af68 (auto-armed on publish)' }
// A Monitor the conversation started itself.
const LOG = { id: 'm9', type: 'monitor', description: 'until the build log says done' }

describe('background work', () => {
  test('reads the Stop hook record and the turn mark, refusing anything else', () => {
    expect(parseRecord('{"tasks":[{"id":"b1","type":"shell","status":"running","description":"npm test"}]}')).toEqual({
      kind: 'tasks',
      tasks: [SHELL],
    })
    expect(parseRecord('{"tasks":[]}')).toEqual({ kind: 'tasks', tasks: [] })
    // 0.4.1 saved wakeups and 0.14.0 their count; Claude Code restores them on resume.
    expect(parseRecord('{"tasks":[],"crons":[{"id":"c1","schedule":"* * * * *"}]}')).toEqual({ kind: 'tasks', tasks: [] })
    expect(parseRecord('{"tasks":[],"wakeups":2}')).toEqual({ kind: 'tasks', tasks: [] })
    expect(parseRecord(turnMark('t1'))).toEqual({ kind: 'turn', turnId: 't1' })
    expect(parseRecord('{"tasks":[{"type":"shell"}]}')).toBe(undefined)
    expect(parseRecord('{"tasks":"b1"}')).toBe(undefined)
    expect(parseRecord('[]')).toBe(undefined)
    expect(parseRecord('{"tasks":[')).toBe(undefined)
  })

  test('knows the background task each kind of tool call started, and nothing from a foreground one', () => {
    expect(taskStarted('Bash', { command: 'npm test', description: 'tests' }, { backgroundTaskId: 'b1', stdout: '' }))
      .toEqual({ id: 'b1', type: 'shell', description: 'tests' })
    expect(taskStarted('Bash', { command: 'ls' }, { stdout: 'a', stderr: '', interrupted: false })).toBe(undefined)
    expect(taskStarted('Monitor', { command: 'tail -f log', description: 'log' }, { taskId: 'm1', timeoutMs: 0 }))
      .toEqual({ id: 'm1', type: 'monitor', description: 'log' })
    expect(taskStarted('Agent', { description: 'scout' }, { status: 'async_launched', agentId: 'a1' }))
      .toEqual(SCOUT)
    expect(taskStarted('Agent', { description: 'scout' }, { status: 'completed', agentId: 'a1' })).toBe(undefined)
    expect(taskStarted('Workflow', { description: 'build' }, { status: 'async_launched', taskId: 'w1' }))
      .toEqual({ id: 'w1', type: 'workflow', description: 'build' })
    expect(taskStarted('Read', { file_path: '/a' }, { content: '' })).toBe(undefined)
    expect(taskStarted('Bash', { command: 'x' }, 'not an object')).toBe(undefined)
  })

  test('a monitor is a watch, not work: it only waits, and starting it again loses nothing', () => {
    expect(isWatch(WATCH)).toBe(true)
    expect(isWatch(LOG)).toBe(true)
    // What a watch watches is work of its own and still counts.
    expect(isWatch({ id: 'b2', type: 'shell', description: 'tail -f build.log' })).toBe(false)
    expect(isWatch(SHELL)).toBe(false)
    expect(isWatch(SCOUT)).toBe(false)
    expect(isWatch({ id: 'w1', type: 'workflow', description: 'build' })).toBe(false)
    expect(working([WATCH, SHELL, LOG, SCOUT])).toEqual([SHELL, SCOUT])
    expect(working([WATCH, LOG])).toEqual([])
  })

  test('names the work in a sentence', () => {
    expect(describeTasks([SHELL])).toBe('1 background task (shell "npm test")')
    expect(describeTasks([SCOUT, { id: 'x9', type: 'monitor', description: '' }]))
      .toBe('2 background tasks (subagent "scout", monitor x9)')
  })
})

describe('/account waits for the work a switch would stop', () => {
  test('an idle session with nothing running switches as soon as the command is done', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    await turn($, w, [])
    const { text } = await $.command.run(run('2'))
    expect(text).toBe('Switched to 2: your next message continues this conversation on it.')
    await w.clock.advance(0)
    expect(w.killed).toEqual([SIGINT])
  })

  test('a turn a queued message starts before the switch runs holds it until that turn ends', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    await $.command.run(run('2'))
    const turnId = await startTurn($)
    await w.clock.advance(0)
    expect(w.killed).toEqual([])
    await endTurn($, w, turnId, [])
    await w.clock.advance(0)
    expect(w.killed).toEqual([SIGINT])
  })

  test('marks each main-loop turn in flight in the record file', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    const turnId = await startTurn($)
    expect(w.files.get(RECORD)).toBe(turnMark(turnId))
  })

  test('a switch asked mid-turn waits for the turn to end, then ends the process once', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    const turnId = await startTurn($)
    const { text } = await $.command.run(run('2'))
    expect(text).toBe(
      'Switch to 2 queued: waiting for this turn to end. Then your next message continues this conversation on 2.\n' +
        'To switch now and stop it, type /account 2 now. To stay on 1, type /account 1.',
    )
    expect(w.statuses.at(-1)).toBe('account 1, switching to 2')
    await w.clock.advance(10000)
    expect(w.killed).toEqual([])
    await endTurn($, w, turnId, [])
    await w.clock.advance(0)
    expect(w.killed).toEqual([SIGINT])
  })

  test('a switch waits while a background task runs and happens when the turn its end wakes is over', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    await turn($, w, [SHELL])
    const { text } = await $.command.run(run('2'))
    expect(text).toContain('Switch to 2 queued: waiting for 1 background task (shell "npm test") to end.')
    expect(text).toContain('type /account 2 now')
    await w.clock.advance(10000)
    expect(w.killed).toEqual([])
    // The task's end wakes the session with a notification turn.
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.killed).toEqual([SIGINT])
  })

  test('a switch waits for a background subagent the agent list shows running', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    w.agents.push({ id: 'a1', description: 'scout', type: 'general-purpose', status: 'running' })
    const { text } = await $.command.run(run('2'))
    expect(text).toContain('waiting for 1 background task (subagent "scout") to end')
    w.agents.splice(0, 1, { id: 'a1', description: 'scout', type: 'general-purpose', status: 'completed' })
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.killed).toEqual([SIGINT])
  })

  test('a switch does not wait for a watch: it goes at once and says the watch ends', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    await turn($, w, [WATCH])
    const { text } = await $.command.run(run('2'))
    expect(text).toBe('Switched to 2, ending 1 watch: your next message continues this conversation on it.')
    await w.clock.advance(0)
    expect(w.killed).toEqual([SIGINT])
  })

  test('a switch waiting for work beside a watch names only the work, and goes when the work ends', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    await turn($, w, [WATCH, SHELL])
    const { text } = await $.command.run(run('2'))
    expect(text).toContain('Switch to 2 queued: waiting for 1 background task (shell "npm test") to end.')
    expect(text).toContain('To switch now and stop it, type /account 2 now.')
    await turn($, w, [WATCH])
    await w.clock.advance(0)
    expect(w.killed).toEqual([SIGINT])
  })

  test('a forced switch names the watches it ends after the work it stops', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    await turn($, w, [SHELL, WATCH, LOG])
    const { text } = await $.command.run(run('2 now'))
    expect(text).toBe(
      'Switched to 2, stopping 1 background task (shell "npm test") and ending 2 watches: your next message continues this conversation on it.',
    )
  })

  test('a move that ended a monitor tells the reopened conversation to start it again; an artifact watch alone needs no word', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    await turn($, w, [WATCH, LOG])
    await $.command.run(run('2'))
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(
      `2 ${SESSION}\n[cc-accounts] Moving this conversation to the 2 account ended this background work, which only watches or waits, ` +
        'so start again whatever of it is still needed: monitor "until the build log says done".\n',
    )
  })

  test('one task ending of two keeps the switch waiting for the other', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    await turn($, w, [SHELL, SCOUT])
    await $.command.run(run('2'))
    await turn($, w, [SCOUT])
    await w.clock.advance(0)
    expect(w.killed).toEqual([])
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.killed).toEqual([SIGINT])
  })

  test('work a turn started before it ended without a Stop hook (a usage limit) still holds the switch', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    await turn($, w, [])
    w.results.set('Bash', { backgroundTaskId: 'b1', stdout: '', stderr: '', interrupted: false })
    const turnId = await startTurn($)
    await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'npm test', run_in_background: true } as never)
    await endTurn($, w, turnId)
    const { text } = await $.command.run(run('2'))
    expect(text).toContain('waiting for 1 background task (shell "npm test") to end')
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.killed).toEqual([SIGINT])
  })

  test('a forced switch ends the process at once, saying what it stops', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    await turn($, w, [SHELL])
    const { text } = await $.command.run(run('2 now'))
    expect(text).toBe(
      'Switched to 2, stopping 1 background task (shell "npm test"): your next message continues this conversation on it.',
    )
    await w.clock.advance(0)
    expect(w.killed).toEqual([SIGINT])
  })

  test('forcing a queued switch carries it out at once', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    await turn($, w, [SHELL])
    await $.command.run(run('2'))
    await $.command.run(run('2 now'))
    await w.clock.advance(0)
    expect(w.killed).toEqual([SIGINT])
  })

  test('a queued switch is carried out once, however often it is asked and turns end', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    await turn($, w, [SHELL])
    await $.command.run(run('2'))
    await $.command.run(run('2'))
    await turn($, w, [])
    await turn($, w, [])
    await w.clock.advance(10000)
    expect(w.killed).toEqual([SIGINT])
  })

  test('a queued switch records the target for cca at once, and asking for this account cancels it', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    expect(w.files.get(BY_SESSION)).toBe('1\n')
    await turn($, w, [SHELL])
    await $.command.run(run('2'))
    expect(w.files.get(BY_SESSION)).toBe('2\n')
    const { text } = await $.command.run(run('1'))
    expect(text).toBe('Cancelled the switch to 2: this session stays on 1.')
    expect(w.files.get(BY_SESSION)).toBe('1\n')
    expect(w.statuses.at(-1)).toBe('account 1')
    await turn($, w, [])
    await w.clock.advance(10000)
    expect(w.killed).toEqual([])
  })

  test('a newer ask replaces a queued one', async ($, on) => {
    const w = world(on, TERMINAL)
    await $.session.start(START)
    await turn($, w, [SHELL])
    await $.command.run(run('2'))
    await $.command.run(run('3'))
    expect(w.files.get(BY_SESSION)).toBe('3\n')
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(`3 ${SESSION}\n`)
    expect(w.ran).toEqual(['exit'])
  })

  test('in a terminal a queued switch leaves its request and exits only when the work is done', async ($, on) => {
    const w = world(on, TERMINAL)
    await $.session.start(START)
    await turn($, w, [SHELL])
    const { text } = await $.command.run(run('2'))
    expect(text).toContain('Then this session closes and reopens on 2.')
    await w.clock.advance(0)
    expect([w.files.has(SWITCH), w.ran]).toEqual([false, []])
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(`2 ${SESSION}\n`)
    expect(w.ran).toEqual(['exit'])
  })

  test("a subagent's turn ending does not carry out a switch", async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    await turn($, w, [SCOUT])
    await $.command.run(run('2'))
    await $.turn.start({ text: 'look', turnId: 'sub-1', agentId: 'a1' })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'sub-1', agentId: 'a1', reason: 'answer' })
    await w.clock.advance(0)
    expect(w.killed).toEqual([])
  })

  test('an unreadable record is reported and what was known stands', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    await turn($, w, [SHELL])
    const turnId = await startTurn($)
    w.files.set(RECORD, '{"tasks":[')
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
    expect(w.logs).toEqual([`cc-accounts: ${RECORD} is not a task list; /account goes by the background work it saw start.`])
    const { text } = await $.command.run(run('2'))
    expect(text).toContain('shell "npm test"')
  })
})

describe('a switch that fails partway', () => {
  // 2026-11-15 review: the timer's first look at the agents sat outside its
  // try, so a failure there was lost and the switch announced stayed undone.
  test('a failure in the timer that carries it out is reported, with what to type again', async ($, on) => {
    const w = world(on, { ...STREAM, CLAUDE_ACCOUNT_SWITCH_FILE: SWITCH })
    await $.session.start(START)
    w.slow.agentsFailAfter = 1
    const { text } = await $.command.run(run('2'))
    expect(text).toMatch(/^Switching to 2/)
    await w.clock.advance(0)
    expect(w.logs.filter(line => /^cc-accounts: the switch to 2 failed \(.+\); type \/account 2 again\.$/.test(line))).toHaveLength(1)
  })
})
