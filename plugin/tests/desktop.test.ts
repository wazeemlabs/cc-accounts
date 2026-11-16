// Sessions nothing can move: the Claude desktop app starts Claude Code itself,
// not through cca, and signs each session in with its own login, so a session
// there runs on the app's account whatever its config dir says. On 2026-11-15
// every desktop session ran on one account while the plugin named it after
// ~/.claude, saved its 100% five-hour reading under ~/.claude's account, and
// stayed at the limit without a word.
import { describe, expect, test } from 'claude-code/testing'
import { parseReading } from '../hooks/usage'
import { BY_SESSION, DESKTOP, HOME, ROOT, SESSION, START, limits, run, saved, turn, world } from './world'

const measure = (w: ReturnType<typeof world>) =>
  ({ context: { window: 200000 }, rateLimits: [...w.limits], changed: ['rateLimits'] }) as never

describe('a desktop session counts on the account the app signed it in to', () => {
  test('its reading is saved under that account, not its config dir', async ($, on) => {
    const w = world(on, DESKTOP)
    await $.session.start(START)
    limits(w, 42.4, 7)
    await $.session.measure(measure(w))
    expect(parseReading(w.files.get(`${ROOT}/usage/2.json`) ?? '')?.windows.five_hour?.percentUsed).toBe(42.4)
    expect(w.files.has(`${ROOT}/usage/1.json`)).toBe(false)
    expect(w.files.get(BY_SESSION)).toBe('2\n')
    expect(w.statuses.at(-1)).toBe('account 2 · 5h 42%, week 7%')
  })

  test("its reading is saved under the app's account though ~/.claude's login record names the app's login too", async ($, on) => {
    const w = world(on, DESKTOP)
    w.files.set(`${HOME}/.claude.json`, '{"oauthAccount":{"emailAddress":"two@example.com","accountUuid":"uuid-two"}}')
    await $.session.start(START)
    limits(w, 42.4, 7)
    await $.session.measure(measure(w))
    expect(parseReading(w.files.get(`${ROOT}/usage/2.json`) ?? '')?.windows.five_hour?.percentUsed).toBe(42.4)
    expect(w.files.has(`${ROOT}/usage/1.json`)).toBe(false)
    expect(w.files.get(BY_SESSION)).toBe('2\n')
  })

  test('signed in to an account cca does not hold, it saves no reading and moves nothing', async ($, on) => {
    const w = world(on, { ...DESKTOP, CLAUDE_CODE_ACCOUNT_UUID: 'uuid-other' })
    await $.session.start(START)
    limits(w, 100)
    await $.session.measure(measure(w))
    await turn($, w, [])
    await w.clock.advance(0)
    expect([...w.files.keys()].filter(path => path.startsWith(`${ROOT}/usage/`))).toEqual([])
    expect(w.files.has(BY_SESSION)).toBe(false)
    expect(w.killed).toEqual([])
  })
})

describe('a session nothing can move says so and where to go on', () => {
  test('one cca did not start stays at the leave line, naming the account with room and the command', async ($, on) => {
    const w = world(on, { CLAUDE_ACCOUNT: '1' })
    await $.session.start(START)
    limits(w, 95)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.get(BY_SESSION)).toBe('1\n')
    expect(w.killed).toEqual([])
    expect(w.logs).toContain(
      "cc-accounts: 1's 5-hour window is at 95% and its weekly window at 0%, and this session cannot move: cca did not start it, " +
        `so nothing would reopen it on another account. 2 has room: go on with this conversation in a terminal with \`cca 2 --resume ${SESSION}\`.`,
    )
    expect(w.statuses.at(-1)).toBe('account 1 · 5h 95%, week 0% · cannot move; 2 has room')
  })

  test('a desktop session at the limit says the app keeps it there, and how to go on in VS Code or a terminal', async ($, on) => {
    const w = world(on, DESKTOP)
    await $.session.start(START)
    limits(w, 100)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.get(BY_SESSION)).toBe('2\n')
    expect(w.killed).toEqual([])
    expect(w.logs).toContain(
      "cc-accounts: 2's 5-hour window is at 100% and its weekly window at 0%, and this session cannot move: the Claude desktop app " +
        'runs it on the account the app is signed in to. 1 has room: close this conversation here, then reopen it in VS Code ' +
        `and type /account 1, or run \`cca 1 --resume ${SESSION}\` in a terminal.`,
    )
    expect(w.statuses.at(-1)).toBe('account 2 · 5h 100%, week 0% · cannot move; 1 has room')
  })

  test('it says so once, not at every turn that ends on the same full window', async ($, on) => {
    const w = world(on, DESKTOP)
    await $.session.start(START)
    limits(w, 100)
    await turn($, w, [])
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.logs.filter(line => line.includes('cannot move')).length).toBe(1)
  })

  test('with no account that has room, it says that too', async ($, on) => {
    const w = world(on, DESKTOP)
    saved(w, '1', 100)
    await $.session.start(START)
    limits(w, 100)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.logs.at(-1)).toMatch(/runs it on the account the app is signed in to\. No other account has room either\.$/)
    expect(w.statuses.at(-1)).toBe('account 2 · 5h 100%, week 0% · cannot move')
  })

  test('it says nothing while its account has room, or when the window resets within minutes', async ($, on) => {
    const w = world(on, DESKTOP)
    await $.session.start(START)
    limits(w, 80)
    await turn($, w, [])
    limits(w, 95, 0, new Date(w.clock.now() + 5 * 60_000).toISOString())
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.logs.filter(line => line.includes('cannot move'))).toEqual([])
  })

  test('/account there says the app keeps the session on its account and how to go on elsewhere, and nothing exits', async ($, on) => {
    const w = world(on, DESKTOP)
    await $.session.start(START)
    const { text } = await $.command.run(run('1'))
    expect(text).toBe(
      'The Claude desktop app runs this session on the account the app is signed in to, 2, and reopening it there keeps it on 2. ' +
        `To go on with it on 1, close it here and reopen it in VS Code, or run \`cca 1 --resume ${SESSION}\` in a terminal.`,
    )
    // It keeps running on the app's account, so it stays counted there.
    expect(w.files.get(BY_SESSION)).toBe('2\n')
    await w.clock.advance(0)
    expect([w.ran, w.killed]).toEqual([[], []])
  })

  test('its status line keeps saying it cannot move through later readings while the window stays full', async ($, on) => {
    const w = world(on, DESKTOP)
    await $.session.start(START)
    limits(w, 95)
    await turn($, w, [])
    limits(w, 96)
    await $.session.measure(measure(w))
    expect(w.statuses.at(-1)).toBe('account 2 · 5h 96%, week 0% · cannot move; 1 has room')
  })

  test('once its account has room again the note goes, and a later full window is told again', async ($, on) => {
    const w = world(on, DESKTOP)
    await $.session.start(START)
    limits(w, 95)
    await turn($, w, [])
    limits(w, 40)
    await turn($, w, [])
    await $.session.measure(measure(w))
    expect(w.statuses.at(-1)).toBe('account 2 · 5h 40%, week 0%')
    limits(w, 95)
    await turn($, w, [])
    expect(w.logs.filter(line => line.includes('cannot move')).length).toBe(2)
  })

  test('a claude cca started from a desktop session is not taken for the desktop app', async ($, on) => {
    const w = world(on, { ...DESKTOP, CLAUDE_CODE_ACCOUNT_UUID: '', CLAUDE_ACCOUNT: '1', CCA_MODE: 'terminal', CCA_PID: '77' })
    await $.session.start(START)
    const { text } = await $.command.run(run('2'))
    expect(text).toContain('This conversation opens on 2 from now on.')
  })
})
