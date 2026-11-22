import { describe, expect, test } from 'claude-code/testing'
import { formatSessions, memoryText, parseProcesses, sessionRows, LONG_IDLE_MS } from '../hooks/sessions'
import type { RunningEntry } from '../hooks/survey'
import { HOME, ROOT, SESSION, START, SUPERVISED, run, world } from './world'

const MIN = 60_000
const HOUR = 60 * MIN
const NOW = Date.parse('2026-11-18T12:00:00Z')

function entry(pid: number, extra: Partial<RunningEntry> = {}): RunningEntry {
  return {
    pid, sessionId: `s-${pid}`, cwd: '/Users/me/work/shop', name: `tab ${pid}`, active: true,
    entrypoint: 'claude-vscode', startedAt: NOW - 3 * HOUR, idleSince: undefined, ...extra,
  }
}

// 10 with two helpers, one of which started another; 20 with none; 30 is no session's.
const PS = [
  '   10     1  409600',
  '   11    10  102400',
  '   12    10   51200',
  '   13    12   51200',
  '   20     1  512000',
  '   30     1  999999',
].join('\n')

describe('/account sessions', () => {
  test('reads each process, its parent and its memory from ps, and passes by a line that is not one', () => {
    const found = parseProcesses(`${PS}\n\n  x  1  5\n 40 1\n 41 1 7 8\n`)
    expect([...found.keys()]).toEqual([10, 11, 12, 13, 20, 30])
    expect(found.get(13)).toEqual({ parent: 12, kb: 51200 })
  })

  test("a session's helpers are every process under it, however deep, and no other session's", () => {
    const rows = sessionRows([entry(10), entry(20)], parseProcesses(PS), new Map([['s-10', 'work']]), new Map([['s-10', 2]]), NOW)
    const ten = rows.find(row => row.sessionId === 's-10')!
    expect([ten.ownKb, ten.helpers, ten.helperKb]).toEqual([409600, 3, 204800])
    expect([ten.account, ten.project, ten.where]).toEqual(['work', 'shop', 'VS Code'])
    const twenty = rows.find(row => row.sessionId === 's-20')!
    expect([twenty.ownKb, twenty.helpers, twenty.helperKb, twenty.account]).toEqual([512000, 0, 0, undefined])
  })

  test('a process listed as its own ancestor is counted once', () => {
    const rows = sessionRows([entry(1)], parseProcesses('1 2 100\n2 1 50\n'), new Map(), new Map(), NOW)
    expect([rows[0]!.helpers, rows[0]!.helperKb]).toEqual([1, 50])
  })

  test('a session whose process ps did not list holds nothing', () => {
    const rows = sessionRows([entry(99)], parseProcesses(PS), new Map(), new Map(), NOW)
    expect([rows[0]!.ownKb, rows[0]!.helpers]).toEqual([0, 0])
  })

  test('the longest idle come first, then the working ones, each by the memory held', () => {
    const rows = sessionRows(
      [entry(20), entry(10), entry(3, { idleSince: NOW - HOUR }), entry(4, { idleSince: NOW - 30 * HOUR })],
      parseProcesses(PS), new Map(), new Map(), NOW,
    )
    expect(rows.map(row => row.sessionId)).toEqual(['s-4', 's-3', 's-10', 's-20'])
    expect(rows.map(row => row.idleMs)).toEqual([30 * HOUR, HOUR, undefined, undefined])
  })

  test('says where a session runs by how it was started', () => {
    const where = (entrypoint: string) => sessionRows([entry(1, { entrypoint })], new Map(), new Map(), new Map(), NOW)[0]!.where
    expect(['claude-desktop', 'claude-vscode', 'cli', '', 'sdk-ts'].map(where)).toEqual(['desktop app', 'VS Code', 'terminal', 'terminal', 'sdk-ts'])
  })

  test('memory reads in MB below a thousand and in GB from there', () => {
    expect([memoryText(0), memoryText(409600), memoryText(1023 * 1024), memoryText(3276800)]).toEqual(['0 MB', '400 MB', '1.0 GB', '3.1 GB'])
  })

  test('the table marks this session and the ones idle over a day, and adds up what they hold', () => {
    const rows = sessionRows(
      [
        entry(10, { name: 'Builder' }),
        entry(20, { name: '', entrypoint: 'claude-desktop', idleSince: NOW - LONG_IDLE_MS - 2 * HOUR, startedAt: NOW - 50 * HOUR, cwd: '' }),
        entry(40, { name: 'Notes', idleSince: NOW - 20_000, startedAt: undefined }),
      ],
      parseProcesses(PS), new Map([['s-10', 'work']]), new Map([['s-10', 2]]), NOW,
    )
    expect(formatSessions(rows, 's-10').split('\n')).toEqual([
      'session  project  account  where        state                     up     memory  helpers',
      's-20     -        -        desktop app  idle 1d 2h                2d 2h  500 MB  -          ← idle over a day',
      'Notes    shop     -        VS Code      idle under a minute       -      0 MB    -',
      'Builder  shop     work     VS Code      working, 2 in background  3h 0m  400 MB  3, 200 MB  ← this session',
      '',
      '3 sessions: 900 MB in the sessions themselves, and 200 MB in 3 helper processes (tool servers, shells and what they started).',
      '1 idle for over a day holds 500 MB.',
      'Close one with /account close <session name or id>, or every one idle for over a day and running nothing with ' +
        '/account close stale. Closing frees its memory and stops the work it runs in the background; the conversation ' +
        "stays, and reopens from the app's or the editor's list or with `claude --resume <id>`.",
    ])
  })

  test('with none idle for a day it says so, and with no session at all only that', () => {
    const rows = sessionRows([entry(11)], parseProcesses(PS), new Map(), new Map(), NOW)
    expect(formatSessions(rows, undefined).split('\n').slice(2, 5)).toEqual([
      '',
      '1 session: 100 MB in the sessions themselves, and 0 MB in 0 helper processes (tool servers, shells and what they started).',
      'None has been idle for a day.',
    ])
    expect(formatSessions([], undefined)).toBe('No sessions are running.')
  })

  test('the command lists the sessions whose processes run, with the account cca recorded for each', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    const now = w.clock.now()
    const registry = (pid: number, sessionId: string, extra: object) =>
      w.files.set(`${HOME}/.claude-shared/sessions/${pid}.json`, JSON.stringify({ pid, sessionId, cwd: '/Users/me/work/shop', name: `tab ${pid}`, entrypoint: 'claude-vscode', startedAt: now - HOUR, ...extra }))
    registry(10, SESSION, { status: 'busy', statusUpdatedAt: now })
    registry(20, 's-20', { status: 'idle', statusUpdatedAt: now - 2 * HOUR })
    registry(50, 's-50', { status: 'idle', statusUpdatedAt: now })
    w.files.set(`${ROOT}/by-session/s-20`, '2\n')
    // An artifact watch beside the shell is not work a close would lose.
    w.files.set(`${ROOT}/background/s-20`, JSON.stringify({ tasks: [{ id: 'b1', type: 'shell', description: 'npm test' }, { id: 'm1', type: 'monitor', description: 'live updates for artifact https://claude.ai/code/artifact/abc (auto-armed on publish)' }] }))
    w.running.add('10').add('20')
    w.processes.table = PS
    const { text } = await $.command.run(run('sessions'))
    expect(text.split('\n').slice(0, 3)).toEqual([
      'session  project  account  where    state                        up     memory  helpers',
      'tab 20   shop     2        VS Code  idle 2h 0m, 1 in background  1h 0m  500 MB  -',
      'tab 10   shop     1        VS Code  working                      1h 0m  400 MB  3, 200 MB  ← this session',
    ])
  })
})
