import { describe, expect, test } from 'claude-code/testing'
import { HOME, ROOT, SESSION, START, SUPERVISED, limits, run, saved, world } from './world'

const HOUR = 3_600_000

const PANE = {
  plugin: 'cc-accounts',
  component: 'Pane',
  requestId: 'cc-accounts',
  props: { title: 'Accounts and sessions', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// 10 is this session, on account 1; 20 idle two days; 30 idle with a background task.
function machine(on: Parameters<typeof world>[0]) {
  const w = world(on, SUPERVISED)
  // Whether a surface draws the pane, as $.ui.open answers.
  const placed = { is: true }
  on('ui.open', () => ({ value: { isPlaced: placed.is } }))
  const now = w.clock.now()
  const registry = (pid: number, sessionId: string, name: string, extra: object) =>
    w.files.set(`${HOME}/.claude-shared/sessions/${pid}.json`, JSON.stringify({ pid, sessionId, cwd: '/Users/me/work/shop', name, entrypoint: 'claude-desktop', startedAt: now - 72 * HOUR, ...extra }))
  registry(10, SESSION, 'Me', { status: 'busy', statusUpdatedAt: now })
  registry(20, 'ssss2020-x', 'Old notes', { status: 'idle', statusUpdatedAt: now - 48 * HOUR })
  registry(30, 'ssss3030-x', 'Render', { status: 'idle', statusUpdatedAt: now - HOUR })
  w.files.set(`${ROOT}/background/ssss3030-x`, JSON.stringify({ tasks: [{ id: 'b1', type: 'shell', description: 'render' }] }))
  for (const pid of ['10', '20', '30']) w.running.add(pid)
  for (const pid of ['20', '30']) w.others.set(pid, 1)
  w.processes.table = '10 1 102400\n20 1 204800\n30 1 102400\n'
  return { ...w, placed }
}

describe('the accounts and sessions pane', () => {
  test('/account dashboard opens it, and where no pane shows says what to type', async ($, on) => {
    const w = machine(on)
    await $.session.start(START)
    expect((await $.command.run(run('dashboard'))).text).toBe('The accounts and sessions pane is open.')
    w.placed.is = false
    expect((await $.command.run(run('dashboard'))).text).toBe(
      'This window shows no panes: /account usage and /account sessions list the same, and /account close closes a session.',
    )
    expect(w.killed).toEqual([])
  })

  test('it draws every account with its use and every session with its state, on every surface', async ($, on) => {
    const w = machine(on)
    limits(w, 42, 10)
    saved(w, '2', 7, 3)
    await $.session.start(START)
    await $.session.measure({ context: { window: 200000 }, rateLimits: [...w.limits], changed: ['rateLimits'] } as never)
    await $.command.run(run('dashboard'))
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ type: 'Text', text: /running, holding/ }))?.text).toBe('3 running, holding 400 MB with the processes they started')
      expect((await ui.find({ type: 'Text', text: /idle 2d/ }))?.text).toBe('desktop app · idle 2d 0h · 200 MB')
      expect((await ui.find({ type: 'Text', text: /in background/ }))?.text).toBe('desktop app · idle 1h 0m, 1 in background · 100 MB')
      expect(await ui.find({ type: 'Text', text: /^idle over a day$/ })).toBeDefined()
      // A bar for each window of each account with a reading.
      expect((await ui.findAll({ type: 'Text', text: /^\d+% used · resets in/ })).length + (await ui.findAll({ type: 'Progress' })).length).toBe(4)
      // Switch for the other account only; Close for the other sessions only.
      const keys = (await ui.findAll({ type: 'Button' })).map(button => button.key)
      expect(keys).toEqual(['switch-2', 'close-ssss2020-x', 'close-ssss3030-x', 'close-stale', 'refresh'])
      await ui.unmount()
    }
  })

  test('Close ends an idle session at one press, and says so', async ($, on) => {
    const w = machine(on)
    await $.session.start(START)
    await $.command.run(run('dashboard'))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'close-ssss2020-x' })
    expect((await ui.find({ type: 'Text', text: /^Closing Old notes/ }))?.text.startsWith('Closing Old notes (idle 2d 0h), holding 200 MB.')).toBe(true)
    await w.clock.advance(0)
    await w.clock.advance(500)
    await w.logged(line => line.startsWith('cc-accounts: closed Old notes'))
    expect(w.killed).toEqual([['kill', '-INT', '20']])
    // Read again once the close has settled: the session is gone from the pane.
    await w.clock.advance(8000)
    expect(await ui.find({ type: 'Button', key: 'close-ssss2020-x' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'close-stale' })).toBeUndefined()
    await ui.unmount()
  })

  test('Close on a session with background work asks first; Keep closes nothing, Close anyway ends it', async ($, on) => {
    const w = machine(on)
    await $.session.start(START)
    await $.command.run(run('dashboard'))
    const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
    await ui.press({ key: 'close-ssss3030-x' })
    expect((await ui.find({ type: 'Text', text: /closing stops that/ }))?.text).toBe('It runs 1 background task; closing stops that.')
    await ui.press({ key: 'keep-ssss3030-x' })
    await w.clock.advance(1000)
    expect(w.killed).toEqual([])
    expect(await ui.find({ type: 'Text', text: /closing stops that/ })).toBeUndefined()
    await ui.press({ key: 'close-ssss3030-x' })
    await ui.press({ key: 'force-ssss3030-x' })
    await w.clock.advance(0)
    await w.clock.advance(500)
    await w.logged(line => line.startsWith('cc-accounts: closed Render'))
    expect(w.killed).toEqual([['kill', '-INT', '30']])
    await ui.unmount()
  })

  test('the button for sessions idle over a day closes those and no other', async ($, on) => {
    const w = machine(on)
    await $.session.start(START)
    await $.command.run(run('dashboard'))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ type: 'Button', key: 'close-stale' }))?.text).toBe('Close 1 idle over a day (200 MB)')
    await ui.press({ key: 'close-stale' })
    await w.clock.advance(0)
    await w.clock.advance(500)
    await w.logged(line => line.startsWith('cc-accounts: closed'))
    expect(w.killed).toEqual([['kill', '-INT', '20']])
    await ui.unmount()
  })

  test('Switch asks for the move as /account does', async ($, on) => {
    const w = machine(on)
    await $.session.start(START)
    await $.command.run(run('dashboard'))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'switch-2' })
    expect((await ui.find({ type: 'Text', text: /^Switching to 2/ }))).toBeDefined()
    await ui.unmount()
  })

  test('minimized to a widget it shows the count and this account at a glance, with no buttons', async ($, on) => {
    machine(on)
    await $.session.start(START)
    await $.command.run(run('dashboard'))
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, placement: 'widget' }, surface: 'desktop' })
    expect((await ui.find({ type: 'Text', text: /sessions/ }))?.text).toBe('3 sessions · 400 MB')
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await ui.unmount()
  })
})
