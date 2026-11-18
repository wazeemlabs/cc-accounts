import { describe, expect, test } from 'claude-code/testing'
import { parseAsk } from '../hooks/accounts'
import { busy, named, stale } from '../hooks/close'
import { LONG_IDLE_MS, type SessionRow } from '../hooks/sessions'
import { HOME, ROOT, SESSION, START, SUPERVISED, run, world } from './world'

const HOUR = 3_600_000

function row(sessionId: string, name: string, extra: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId, pid: 1, name, project: 'shop', account: '1', where: 'VS Code', idleMs: HOUR, upMs: HOUR, tasks: 0,
    ownKb: 102400, helpers: 0, helperKb: 0, helperPids: [], ...extra,
  }
}

const ROWS = [row('aaaa1111-x', 'Builder'), row('bbbb2222-x', 'Build notes'), row('cccc3333-x', ''), row('dddd4444-x', 'builder')]

describe('/account close: which sessions', () => {
  test('everything after close names the session, spaces and quotes included, but for a last word now', () => {
    expect(parseAsk('close Machine disk space cleanup')).toEqual({ kind: 'close', target: 'Machine disk space cleanup', force: false })
    expect(parseAsk('close "Machine disk  cleanup" now')).toEqual({ kind: 'close', target: 'Machine disk  cleanup', force: true })
    expect(parseAsk('close stale')).toEqual({ kind: 'close', target: 'stale', force: false })
    expect(parseAsk('close know-how')).toEqual({ kind: 'close', target: 'know-how', force: false })
    expect(parseAsk('close')).toEqual({ kind: 'help' })
  })

  test('a session is named by the start of its id, its name, or the start of its name, letter case aside', () => {
    const ids = (target: string) => named(ROWS, target).map(found => found.sessionId[0])
    expect(ids('cccc3')).toEqual(['c'])
    expect(ids('BUILDER')).toEqual(['a', 'd'])
    expect(ids('build n')).toEqual(['b'])
    expect(ids('build')).toEqual(['a', 'b', 'd'])
    expect(ids('nothing')).toEqual([])
    // Too short to be an id, and no name starts with it.
    expect(ids('ccc')).toEqual([])
  })

  test('stale is idle for over a day with nothing running, and never this session', () => {
    const rows = [
      row('a', 'old', { idleMs: LONG_IDLE_MS }),
      row('b', 'old and busy', { idleMs: LONG_IDLE_MS, tasks: 1 }),
      row('c', 'recent', { idleMs: LONG_IDLE_MS - 1 }),
      row('d', 'working', { idleMs: undefined }),
      row('e', 'me', { idleMs: 2 * LONG_IDLE_MS }),
    ]
    expect(stale(rows, 'e').map(found => found.sessionId)).toEqual(['a'])
  })

  test('a working session and one with background work are busy; an idle one with none is not', () => {
    expect(busy(row('a', 'x', { idleMs: undefined }))).toBe('is working')
    expect(busy(row('a', 'x', { tasks: 1 }))).toBe('runs 1 background task')
    expect(busy(row('a', 'x', { tasks: 2 }))).toBe('runs 2 background tasks')
    expect(busy(row('a', 'x'))).toBeUndefined()
  })
})

// 10 is this session; 20 idle two days with helpers 21 and 22; 30 idle an hour
// with a background task; 40 working.
function machine(on: Parameters<typeof world>[0]) {
  const w = world(on, SUPERVISED)
  const now = w.clock.now()
  const registry = (pid: number, sessionId: string, name: string, extra: object) =>
    w.files.set(`${HOME}/.claude-shared/sessions/${pid}.json`, JSON.stringify({ pid, sessionId, cwd: '/Users/me/work/shop', name, entrypoint: 'claude-desktop', startedAt: now - 72 * HOUR, ...extra }))
  registry(10, SESSION, 'Me', { status: 'busy', statusUpdatedAt: now })
  registry(20, 'ssss2020-x', 'Old notes', { status: 'idle', statusUpdatedAt: now - 48 * HOUR })
  registry(30, 'ssss3030-x', 'Render', { status: 'idle', statusUpdatedAt: now - HOUR })
  registry(40, 'ssss4040-x', 'Writer', { status: 'busy', statusUpdatedAt: now })
  w.files.set(`${ROOT}/background/ssss3030-x`, JSON.stringify({ tasks: [{ id: 'b1', type: 'shell', description: 'render' }] }))
  for (const pid of ['10', '20', '30', '40']) w.running.add(pid)
  for (const pid of ['20', '30', '40']) w.others.set(pid, 1)
  w.processes.table = '10 1 102400\n20 1 204800\n21 20 51200\n22 21 51200\n30 1 102400\n40 1 102400\n'
  return w
}

describe('/account close: ending them', () => {
  test('an idle session with nothing running is ended, with the helpers it leaves behind, and what was freed is said', async ($, on) => {
    const w = machine(on)
    await $.session.start(START)
    // 21 outlives its session; 22 ends with it.
    w.helpers.set('21', '1')
    const { text } = await $.command.run(run('close old notes'))
    expect(text).toBe(
      'Closing Old notes (idle 2d 0h), holding 300 MB. Each conversation stays and reopens from the app\'s or the editor\'s list, ' +
        'or with `claude --resume <id>`; a line here says when it is done.',
    )
    expect(w.killed).toEqual([])
    await w.clock.advance(0)
    await w.clock.advance(500)
    await w.logged(line => line.startsWith('cc-accounts: closed'))
    expect(w.killed).toEqual([['kill', '-INT', '20'], ['kill', '-TERM', '21']])
    expect(w.logs.at(-1)).toBe('cc-accounts: closed Old notes: about 300 MB freed.')
  })

  test('a session with background work, or working, is closed only with now', async ($, on) => {
    const w = machine(on)
    await $.session.start(START)
    expect((await $.command.run(run('close render'))).text).toBe(
      'Render runs 1 background task, which closing it would stop. To close it anyway, type /account close render now.',
    )
    expect((await $.command.run(run('close ssss4040'))).text).toBe(
      'Writer is working, which closing it would stop. To close it anyway, type /account close ssss4040 now.',
    )
    await w.clock.advance(1000)
    expect(w.killed).toEqual([])
    await $.command.run(run('close render now'))
    await w.clock.advance(0)
    await w.clock.advance(500)
    await w.logged(line => line.startsWith('cc-accounts: closed Render'))
    expect(w.killed).toEqual([['kill', '-INT', '30']])
  })

  test('stale closes every session idle over a day that runs nothing, and no other', async ($, on) => {
    const w = machine(on)
    await $.session.start(START)
    const { text } = await $.command.run(run('close stale'))
    expect(text.startsWith('Closing Old notes (idle 2d 0h), holding 300 MB.')).toBe(true)
    await w.clock.advance(0)
    await w.clock.advance(500)
    await w.logged(line => line.startsWith('cc-accounts: closed'))
    expect(w.killed).toEqual([['kill', '-INT', '20']])
    // Gone now: nothing is stale.
    expect((await $.command.run(run('close stale'))).text).toBe(
      'No other session has been idle for over a day with nothing running. /account sessions lists them all.',
    )
  })

  test('this session, a name no session has and a name several have close nothing', async ($, on) => {
    const w = machine(on)
    w.files.set(`${HOME}/.claude-shared/sessions/50.json`, JSON.stringify({ pid: 50, sessionId: 'ssss5050-x', cwd: '/x', name: 'Old news', status: 'idle', statusUpdatedAt: 0 }))
    w.running.add('50')
    await $.session.start(START)
    expect((await $.command.run(run('close me'))).text).toBe('That is this session: type /exit to close it.')
    expect((await $.command.run(run('close nobody'))).text).toBe(
      'No running session is named nobody, or has an id that starts with it. /account sessions lists them.',
    )
    expect((await $.command.run(run('close old'))).text).toBe(
      '2 sessions match old: Old notes (ssss2020), Old news (ssss5050). Name one by its id.',
    )
    await w.clock.advance(1000)
    expect(w.killed).toEqual([])
  })

  test('a session that takes every signal and still runs is said to run on', async ($, on) => {
    const w = machine(on)
    w.others.set('20', 9)
    await $.session.start(START)
    await $.command.run(run('close old notes'))
    await w.clock.advance(0)
    for (let waited = 0; waited < 7000; waited += 500) await w.clock.advance(500)
    await w.logged(line => line.startsWith('cc-accounts: could not close'))
    expect(w.killed).toEqual([['kill', '-INT', '20'], ['kill', '-INT', '20'], ['kill', '-TERM', '20']])
    expect(w.logs.at(-1)).toBe('cc-accounts: could not close Old notes (still running after SIGINT, SIGINT, SIGTERM); it runs on.')
  })
})
