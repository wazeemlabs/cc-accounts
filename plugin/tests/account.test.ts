import { describe, expect, test } from 'claude-code/testing'
import { accountUuidIn, currentAccount, parseAsk, parseTable } from '../hooks/accounts'
import { HOME, ROOT, SELF, SESSION, START, STREAM, SUPERVISED, SUPERVISOR, SWITCH, TERMINAL, run, world } from './world'

describe('parsing', () => {
  test('reads the account table, skipping blank and malformed lines', () => {
    expect(parseTable('1\t/a\n\nbad line\n2\t/b\n')).toEqual([
      { name: '1', dir: '/a' },
      { name: '2', dir: '/b' },
    ])
  })

  test('reads /account arguments', () => {
    expect(parseAsk('')).toEqual({ kind: 'list' })
    expect(parseAsk('  2 ')).toEqual({ kind: 'switch', name: '2', force: false })
    expect(parseAsk('2 now')).toEqual({ kind: 'switch', name: '2', force: true })
    expect(parseAsk('default 3')).toEqual({ kind: 'default', name: '3' })
    expect(parseAsk('default now')).toEqual({ kind: 'default', name: 'now' })
    expect(parseAsk('default')).toEqual({ kind: 'help' })
    expect(parseAsk('2 3')).toEqual({ kind: 'help' })
    expect(parseAsk('2 now please')).toEqual({ kind: 'help' })
    expect(parseAsk('usage')).toEqual({ kind: 'report' })
    expect(parseAsk('priority')).toEqual({ kind: 'priority', weight: undefined, folder: undefined })
    expect(parseAsk('priority 3')).toEqual({ kind: 'priority', weight: '3', folder: undefined })
    expect(parseAsk('priority 0.5  ~/Documents/My Project ')).toEqual({ kind: 'priority', weight: '0.5', folder: '~/Documents/My Project' })
    expect(parseAsk('budget 2 "~/Library/Application Support"')).toEqual({ kind: 'budget', points: '2', folder: '~/Library/Application Support' })
    expect(parseAsk("priority 2 '/a b'")).toEqual({ kind: 'priority', weight: '2', folder: '/a b' })
    expect(parseAsk('budget 2 "/a b')).toEqual({ kind: 'budget', points: '2', folder: '"/a b' })
  })

  test('names the current account by CLAUDE_ACCOUNT, else by config dir, ~/.claude when unset', () => {
    const accounts = parseTable(`1\t${HOME}/.claude\n2\t${HOME}/.claude-two\n`)
    expect(currentAccount(accounts, '2', undefined, HOME)?.name).toBe('2')
    expect(currentAccount(accounts, undefined, `${HOME}/.claude-two/`, HOME)?.name).toBe('2')
    expect(currentAccount(accounts, undefined, undefined, HOME)?.name).toBe('1')
    expect(currentAccount(accounts, 'gone', '/elsewhere', HOME)).toBe(undefined)
  })

  // The Claude desktop app signs a session in with its own login and names it
  // in CLAUDE_CODE_ACCOUNT_UUID, while the config dir stays ~/.claude: on
  // 2026-11-15 every desktop session ran on one account and saved its 100%
  // five-hour reading under ~/.claude's.
  test('a session its host signs in runs on the account whose login has the id the host names, whatever its config dir', () => {
    const accounts = parseTable(`1\t${HOME}/.claude\n2\t${HOME}/.claude-two\n`)
    const logins = new Map([['1', 'uuid-one'], ['2', 'uuid-two']])
    expect(currentAccount(accounts, undefined, undefined, HOME, { accountUuid: 'uuid-two', logins })?.name).toBe('2')
    expect(currentAccount(accounts, '1', `${HOME}/.claude`, HOME, { accountUuid: 'uuid-two', logins })?.name).toBe('2')
  })

  // A session writes the login it runs on into its own config dir's login
  // record, so a desktop session (config dir ~/.claude) leaves the app's login
  // in ~/.claude.json, which is also the record of the account kept in
  // ~/.claude. On 2026-11-16 both that account and the app's own named the
  // host's id; the first in the table won, desktop sessions saved the app
  // account's readings under ~/.claude's account, and the balancer sent
  // sessions to an account whose week was full, which sent them straight back.
  test("a session's own login record does not vouch for its account while another account holds that login", () => {
    const accounts = parseTable(`1\t${HOME}/.claude\n2\t${HOME}/.claude-two\n`)
    const host = { accountUuid: 'uuid-two', logins: new Map([['1', 'uuid-two'], ['2', 'uuid-two']]) }
    expect(currentAccount(accounts, undefined, undefined, HOME, host)?.name).toBe('2')
    expect(currentAccount(accounts, undefined, `${HOME}/.claude/`, HOME, host)?.name).toBe('2')
    // Run from the other account's dir, it is the other way round.
    expect(currentAccount(accounts, undefined, `${HOME}/.claude-two`, HOME, host)?.name).toBe('1')
  })

  test("a session's own login record names its account when no other account holds that login", () => {
    const accounts = parseTable(`1\t${HOME}/.claude\n2\t${HOME}/.claude-two\n`)
    const host = { accountUuid: 'uuid-one', logins: new Map([['1', 'uuid-one'], ['2', 'uuid-two']]) }
    expect(currentAccount(accounts, undefined, undefined, HOME, host)?.name).toBe('1')
  })

  test('a host login two other accounts both hold names neither', () => {
    const accounts = parseTable(`1\t${HOME}/.claude\n2\t${HOME}/.claude-two\n3\t${HOME}/.claude-three\n`)
    const host = { accountUuid: 'uuid-x', logins: new Map([['1', 'uuid-x'], ['2', 'uuid-x'], ['3', 'uuid-x']]) }
    expect(currentAccount(accounts, undefined, undefined, HOME, host)).toBe(undefined)
  })

  test('a host login no account holds is an account cca does not know', () => {
    const accounts = parseTable(`1\t${HOME}/.claude\n2\t${HOME}/.claude-two\n`)
    const logins = new Map([['1', 'uuid-one']])
    expect(currentAccount(accounts, undefined, undefined, HOME, { accountUuid: 'uuid-other', logins })).toBe(undefined)
  })

  test('reads the account id from a login record, and none from one mid-write or signed out', () => {
    expect(accountUuidIn('{"oauthAccount":{"accountUuid":"uuid-one","emailAddress":"one@example.com"}}')).toBe('uuid-one')
    expect(accountUuidIn('{"oauthAccount":{"accountUuid":""}}')).toBe(undefined)
    expect(accountUuidIn('{"oauthAccount":')).toBe(undefined)
    expect(accountUuidIn('{}')).toBe(undefined)
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

  test('lists every account with its email and last usage reading, marking this session and the default', async ($, on) => {
    const w = world(on, { CLAUDE_ACCOUNT: '2' })
    w.files.set(`${ROOT}/default`, '1\n')
    w.files.set(
      `${ROOT}/usage/2.json`,
      JSON.stringify({ account: '2', at: 0, windows: { five_hour: { percentUsed: 42.4, resetsAt: '2100-01-01T00:00:00Z' }, seven_day: { percentUsed: 7 } } }),
    )
    await $.session.start(START)
    const { text } = await $.command.run(run(''))
    // Unmeasured, the default gives way to the measured account with room.
    expect(text).toContain('1        one@example.com              -                     ← default, passed over')
    expect(text).toContain('2        two@example.com              5h 42%, week 7%       ← this session, new sessions')
    expect(text).toContain('3        (not signed in)              -')
  })

  test('switching in a cca terminal leaves the request and exits', async ($, on) => {
    const w = world(on, TERMINAL)
    await $.session.start(START)
    const { text } = await $.command.run(run('2'))
    expect(text).toBe('Switching to 2: this session closes and reopens on it.')
    expect(w.files.get(`${ROOT}/by-session/${SESSION}`)).toBe('2\n')
    expect(w.ran).toEqual([])
    await w.clock.advance(0)
    expect(w.files.get(SWITCH)).toBe(`2 ${SESSION}\n`)
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
    await w.clock.advance(10000)
    expect(w.killed).toEqual([['kill', '-INT', SELF]])
    expect(w.ran).toEqual([])
    expect(w.logs).toEqual([])
  })

  test('a session a new turn reaches before the signal survives its first SIGINT and is ended by a second', async ($, on) => {
    const w = world(on, STREAM, 2)
    await $.session.start(START)
    await $.command.run(run('2'))
    await w.clock.advance(0)
    expect(w.killed).toEqual([['kill', '-INT', SELF]])
    await w.clock.advance(2500)
    expect(w.killed).toEqual([['kill', '-INT', SELF]])
    await w.clock.advance(10000)
    expect(w.killed).toEqual([['kill', '-INT', SELF], ['kill', '-INT', SELF]])
    expect(w.logs).toEqual([])
  })

  test('a session that survives both SIGINTs gets SIGTERM, and one that survives that is reported', async ($, on) => {
    const w = world(on, STREAM, Infinity)
    await $.session.start(START)
    await $.command.run(run('2'))
    await w.clock.advance(10000)
    expect(w.killed).toEqual([['kill', '-INT', SELF], ['kill', '-INT', SELF], ['kill', '-TERM', SELF]])
    expect(w.logs).toEqual([
      'cc-accounts: could not end this session (still running after SIGINT, SIGINT, SIGTERM), so it runs on as it is; ' +
        'close this tab and reopen the conversation to move it to 2.',
    ])
  })

  test('a switch that cannot end the process is withdrawn, and cca-stream passes the panel on to it again', async ($, on) => {
    const w = world(on, SUPERVISED, Infinity)
    await $.session.start(START)
    await $.command.run(run('2'))
    await w.clock.advance(10000)
    expect(w.killed.length).toBe(3)
    expect(w.files.has(SWITCH)).toBe(false)
    expect(w.released).toEqual([SUPERVISOR])
  })

  test('marks where new sessions start, and the default when it is passed over', async ($, on) => {
    const w = world(on, { CLAUDE_ACCOUNT: '2' })
    w.files.set(`${ROOT}/default`, '1\n')
    w.files.set(
      `${ROOT}/usage/1.json`,
      JSON.stringify({ account: '1', at: 0, windows: { five_hour: { percentUsed: 85, resetsAt: '2100-01-01T00:00:00Z' } } }),
    )
    await $.session.start(START)
    const { text } = await $.command.run(run(''))
    expect(text).toContain('1        one@example.com              5h 85%                ← default, passed over')
    expect(text).toContain('2        two@example.com              -                     ← this session, new sessions')
    expect(w.files.get(`${ROOT}/start`)).toBe('2\n')
  })

  test('/account default is written whole, never half for cca to read', async ($, on) => {
    const w = world(on, STREAM)
    await $.session.start(START)
    await $.command.run(run('default 2'))
    expect(w.files.get(`${ROOT}/default`)).toBe('2\n')
    expect(w.writes).not.toContain(`${ROOT}/default`)
    expect([...w.files.keys()].filter(path => path.endsWith('.tmp'))).toEqual([])
  })

  test('a session start that cannot record its account says so', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.failWrites.add(`${ROOT}/by-session/`)
    await $.session.start(START)
    expect(w.logs.some(text => text.startsWith('cc-accounts: could not') && text.includes('Permission denied'))).toBe(true)
  })

  test('/account default that cannot be saved says so', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    w.failWrites.add(`${ROOT}/default`)
    const { text } = await $.command.run(run('default 2'))
    expect(text).toContain('could not')
    expect(text).toContain('Permission denied')
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
