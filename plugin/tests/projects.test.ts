import { describe, expect, test } from 'claude-code/testing'
import { priorityFile } from '../hooks/priorities'
import {
  BY_SESSION,
  HOME,
  ROOT,
  SELF,
  START,
  SUPERVISED,
  limits,
  run,
  saved,
  session,
  signInThree,
  turn,
  world,
} from './world'

const SIGINT = ['kill', '-INT', SELF]
const weights = (value: Record<string, number>) => `${JSON.stringify(value)}\n`

// START.cwd, where this session started, is /work.
describe('a lighter session makes room for a heavier one', () => {
  test('from 75% of five hours it moves off an account a heavier project shares', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.files.set(priorityFile(ROOT), weights({ '/heavy': 3 }))
    session(w, 11, '1', true, '/heavy/app')
    await $.session.start(START)
    limits(w, 78)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.get(BY_SESSION)).toBe('2\n')
    expect(w.killed).toEqual([SIGINT])
    expect(w.logs).toContain(
      "cc-accounts: 1's 5-hour window is at 78% and its weekly window at 0%, and heavy (priority 3) on it outweighs this project " +
        '(priority 1); moving this conversation to 2.',
    )
  })

  const stays = [
    ['below 75%', 1, 3, 74],
    ['beside an equal one', 2, 2, 80],
    ['as the heavier one itself', 3, 1, 80],
  ] as const
  for (const [when, mine, other, use] of stays) {
    test(`${when}, it stays`, async ($, on) => {
      const w = world(on, SUPERVISED)
      w.files.set(priorityFile(ROOT), weights({ '/work': mine, '/other': other }))
      session(w, 11, '1', true, '/other')
      await $.session.start(START)
      limits(w, use)
      await turn($, w, [])
      await w.clock.advance(0)
      expect(w.killed).toEqual([])
    })
  }

  test('with no account under the take line to go to, it stays and says nothing', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.files.set(priorityFile(ROOT), weights({ '/heavy': 3 }))
    session(w, 11, '1', true, '/heavy')
    saved(w, '2', 80)
    await $.session.start(START)
    limits(w, 78)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.killed).toEqual([])
    expect(w.logs.filter(line => line.includes('no other account'))).toEqual([])
  })
})

describe('a mover keeps off the accounts heavier projects use', () => {
  // 2 is at 10% with one session, 3 at 25% with none: at weight 1 the session
  // on 2 costs 10 points (20 < 25), at weight 3 it costs 30 (40 > 25).
  for (const [weight, expected] of [[3, '3\n'], [1, '2\n']] as const) {
    test(`a session of weight ${weight} on an account counts as ${weight}`, async ($, on) => {
      const w = world(on, SUPERVISED)
      signInThree(w)
      saved(w, '2', 10)
      saved(w, '3', 25)
      session(w, 11, '2', true, '/heavy')
      w.files.set(priorityFile(ROOT), weights({ '/heavy': weight }))
      await $.session.start(START)
      limits(w, 92)
      await turn($, w, [])
      await w.clock.advance(0)
      expect(w.files.get(BY_SESSION)).toBe(expected)
    })
  }
})

describe('/account priority', () => {
  test("sets this project's weight, shows it, and setting 1 drops it", async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    expect((await $.command.run(run('priority 3'))).text)
      .toBe('work (/work) now counts at 3, and so do the folders inside it that have no weight of their own.')
    expect(JSON.parse(w.files.get(priorityFile(ROOT)) ?? '{}')).toEqual({ '/work': 3 })
    expect((await $.command.run(run('priority'))).text?.split('\n').slice(0, 3)).toEqual([
      'This project, work, counts at 3 (set for /work).',
      'Weights set:',
      '  3    /work',
    ])
    expect((await $.command.run(run('priority 1'))).text).toBe('work (/work) counts at the default, 1, again.')
    expect(JSON.parse(w.files.get(priorityFile(ROOT)) ?? '')).toEqual({})
  })

  test('sets another folder, ~ and spaces allowed, and refuses a bad weight or a relative folder', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    await $.command.run(run('priority 0.5 ~/code/My App/'))
    expect(JSON.parse(w.files.get(priorityFile(ROOT)) ?? '{}')).toEqual({ [`${HOME}/code/My App`]: 0.5 })
    expect((await $.command.run(run('priority 0'))).text).toBe('A weight is a number above 0 and at most 100, such as 3 or 0.5.')
    expect((await $.command.run(run('priority 2 code/app'))).text).toBe('Name the folder as a full path, or ~/ and the rest of it.')
  })

  test('a priorities file that is not one is reported, and every project counts at 1', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.files.set(priorityFile(ROOT), '{"/work": "high"}')
    await $.session.start(START)
    expect((await $.command.run(run('priority'))).text?.split('\n')[0]).toBe('This project, work, counts at 1, the default.')
    expect(w.logs).toContain(`cc-accounts: ${priorityFile(ROOT)} is not a priorities file; every project counts at 1.`)
  })
})

describe('/account usage and the list', () => {
  test('usage shows the accounts, the totals and the projects; the list ends with the totals', async ($, on) => {
    const w = world(on, SUPERVISED)
    saved(w, '2', 40)
    session(w, 11, '2', true, '/p/app', 'App')
    await $.session.start(START)
    const usage = (await $.command.run(run('usage'))).text ?? ''
    expect(usage.split('\n')[0]).toBe('account     5-hour free  resets in  week free  resets in   sessions')
    expect(usage).toContain('Free now, in Max 5x plans: 0.60 of the 5-hour windows and 1.00 of the weeks, over 1 account.')
    expect(usage).toContain('app                             1         1   2')
    const list = (await $.command.run(run(''))).text ?? ''
    expect(list.split('\n').at(-1)).toBe(
      'Free now, in Max 5x plans: 0.60 of the 5-hour windows and 1.00 of the weeks, over 1 account. ' +
        '/account usage shows when it comes back and where each project runs.',
    )
  })
})
