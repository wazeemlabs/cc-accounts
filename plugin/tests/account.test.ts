import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { currentAccount, parseAsk, parseTable } from '../hooks/accounts'

const HOME = '/Users/me'
const ROOT = `${HOME}/.claude-shared/accounts`
const SESSION = '0f4a6c1e-1111-4222-8333-944455556666'
const SWITCH = `${ROOT}/switch/123`
// This process is 500; cca (terminal) is its parent, 400.
const SELF = '500'
const PARENT = '400'
const TERMINAL = { CLAUDE_ACCOUNT: '1', CCA_MODE: 'terminal', CCA_PID: PARENT, CLAUDE_ACCOUNT_SWITCH_FILE: SWITCH }
const STREAM = { CLAUDE_ACCOUNT: '1', CCA_MODE: 'stream', CCA_PID: SELF }

// The world beneath the mod: an in-memory disk, the session's id, and a
// record of the commands it runs and registers.
function world(on: On, env: Record<string, string>) {
  const files = new Map<string, string>([
    [`${ROOT}/accounts.tsv`, `1\t${HOME}/.claude\n2\t${HOME}/.claude-two\n3\t${HOME}/.claude-three\n`],
    [`${HOME}/.claude.json`, '{"oauthAccount":{"emailAddress":"one@example.com"}}'],
    [`${HOME}/.claude-two/.claude.json`, '{"oauthAccount":{"emailAddress":"two@example.com"}}'],
  ])
  const ran: string[] = []
  const statuses: (string | undefined)[] = []
  const logs: string[] = []
  const killed: string[][] = []
  mock.env(on, { HOME, ...env })
  const clock = mock.clock(on)
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('session.id', async () => ({ value: SESSION }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('command.run', { command: 'exit' }, async (_$, e) => {
    ran.push(e.command)
    return {}
  })
  on('process.run', async (_$, e) => {
    if (e.argv[0] === '/bin/sh') {
      return { value: { exitCode: 0, stdout: `${SELF}\n ${PARENT}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    killed.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.log', async (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', async (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  return { files, ran, statuses, logs, clock, killed }
}

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

const run = (args: string) => ({
  command: 'account',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
}) as const

describe('parsing', () => {
  test('reads the account table, skipping blank and malformed lines', () => {
    expect(parseTable('1\t/a\n\nbad line\n2\t/b\n')).toEqual([
      { name: '1', dir: '/a' },
      { name: '2', dir: '/b' },
    ])
  })

  test('reads /account arguments', () => {
    expect(parseAsk('')).toEqual({ kind: 'list' })
    expect(parseAsk('  2 ')).toEqual({ kind: 'switch', name: '2' })
    expect(parseAsk('default 3')).toEqual({ kind: 'default', name: '3' })
    expect(parseAsk('default')).toEqual({ kind: 'usage' })
    expect(parseAsk('2 3')).toEqual({ kind: 'usage' })
  })

  test('names the current account by CLAUDE_ACCOUNT, else by config dir, ~/.claude when unset', () => {
    const accounts = parseTable(`1\t${HOME}/.claude\n2\t${HOME}/.claude-two\n`)
    expect(currentAccount(accounts, '2', undefined, HOME)?.name).toBe('2')
    expect(currentAccount(accounts, undefined, `${HOME}/.claude-two/`, HOME)?.name).toBe('2')
    expect(currentAccount(accounts, undefined, undefined, HOME)?.name).toBe('1')
    expect(currentAccount(accounts, 'gone', '/elsewhere', HOME)).toBe(undefined)
  })
})

describe('/account', () => {
  test('reads its state from CCA_ROOT when cca names one', async ($, on) => {
    const w = world(on, { CLAUDE_ACCOUNT: '2', CCA_ROOT: '/elsewhere' })
    w.files.set('/elsewhere/accounts.tsv', w.files.get(`${ROOT}/accounts.tsv`) ?? '')
    await $.session.start(START)
    expect(w.files.get(`/elsewhere/by-session/${SESSION}`)).toBe('2\n')
    expect(w.files.has(`${ROOT}/by-session/${SESSION}`)).toBe(false)
  })

  test('session start records the account the conversation runs on and shows it', async ($, on) => {
    const w = world(on, { CLAUDE_ACCOUNT: '2' })
    await $.session.start(START)
    expect(w.files.get(`${ROOT}/by-session/${SESSION}`)).toBe('2\n')
    expect(w.statuses).toEqual(['account 2'])
  })

  test('lists every account with its email, marking this session and the default', async ($, on) => {
    const w = world(on, { CLAUDE_ACCOUNT: '2' })
    w.files.set(`${ROOT}/default`, '1\n')
    await $.session.start(START)
    const { text } = await $.command.run(run(''))
    expect(text).toContain('1        one@example.com               ← new sessions')
    expect(text).toContain('2        two@example.com               ← this session')
    expect(text).toContain('3        (not signed in)')
  })

  test('switching in a cca terminal leaves the request and exits', async ($, on) => {
    const w = world(on, TERMINAL)
    await $.session.start(START)
    const { text } = await $.command.run(run('2'))
    expect(text).toBe('Switching to 2: this session closes and reopens on it.')
    expect(w.files.get(SWITCH)).toBe(`2 ${SESSION}\n`)
    expect(w.files.get(`${ROOT}/by-session/${SESSION}`)).toBe('2\n')
    expect(w.ran).toEqual([])
    await w.clock.advance(0)
    expect(w.logs).toEqual([])
    expect(w.ran).toEqual(['exit'])
  })

  test('switching to an account with no login says to sign in', async ($, on) => {
    world(on, TERMINAL)
    await $.session.start(START)
    const { text } = await $.command.run(run('3'))
    expect(text).toContain('3 is not signed in yet')
  })

  test('in VS Code (stream) switching ends this process with SIGINT once the command is done', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    const { text } = await $.command.run(run('2'))
    expect(text).toBe('Switched to 2: your next message continues this conversation on it.')
    expect(w.files.get(`${ROOT}/by-session/${SESSION}`)).toBe('2\n')
    expect(w.killed).toEqual([])
    await w.clock.advance(0)
    expect(w.killed).toEqual([['kill', '-INT', SELF]])
    expect(w.ran).toEqual([])
    expect(w.logs).toEqual([])
  })

  test('a claude started inside a cca terminal session does not switch its parent', async ($, on) => {
    // Inherited: the parent session's variables, naming another process.
    const w = world(on, { ...TERMINAL, CCA_PID: '77' })
    await $.session.start(START)
    const { text } = await $.command.run(run('2'))
    expect(text).toContain('This conversation opens on 2 from now on.')
    expect(w.files.has(SWITCH)).toBe(false)
    await w.clock.advance(0)
    expect([w.ran, w.killed]).toEqual([[], []])
  })

  test('a claude started inside a VS Code session does not end its parent', async ($, on) => {
    const w = world(on, { ...STREAM, CCA_PID: '77' })
    await $.session.start(START)
    const { text } = await $.command.run(run('2'))
    expect(text).toContain('This conversation opens on 2 from now on.')
    await w.clock.advance(0)
    expect([w.ran, w.killed]).toEqual([[], []])
  })

  test('without cca the choice waits for the next open and nothing exits', async ($, on) => {
    const w = world(on, { CLAUDE_CONFIG_DIR: `${HOME}/.claude-two` })
    await $.session.start(START)
    const { text } = await $.command.run(run('1'))
    expect(text).toContain('This conversation opens on 1 from now on.')
    expect(text).toContain(`claude --resume ${SESSION}`)
    expect(w.files.get(`${ROOT}/by-session/${SESSION}`)).toBe('1\n')
    expect(w.files.has(SWITCH)).toBe(false)
    await w.clock.advance(0)
    expect([w.ran, w.killed]).toEqual([[], []])
  })

  test('refuses an unknown account and a switch to the current one, changing nothing', async ($, on) => {
    const w = world(on, TERMINAL)
    await $.session.start(START)
    const unknown = await $.command.run(run('nope'))
    expect(unknown.text).toBe('No account named nope. Accounts: 1, 2, 3.')
    const same = await $.command.run(run('1'))
    expect(same.text).toBe('This session already runs on 1.')
    expect(w.files.has(SWITCH)).toBe(false)
    expect(w.ran).toEqual([])
  })

  test('default sets the account new sessions start on', async ($, on) => {
    const w = world(on, { CLAUDE_ACCOUNT: '1' })
    await $.session.start(START)
    const { text } = await $.command.run(run('default 2'))
    expect(text).toBe('New sessions start on 2.')
    expect(w.files.get(`${ROOT}/default`)).toBe('2\n')
  })

  test('says how to set up when there is no account table', async ($, on) => {
    const w = world(on, {})
    w.files.delete(`${ROOT}/accounts.tsv`)
    await $.session.start(START)
    const { text } = await $.command.run(run(''))
    expect(text).toContain('cca init <name>')
    expect(w.statuses).toEqual([])
  })
})
