import { describe, expect, test } from 'claude-code/testing'
import {
  artifactsText, callContext, elsewhere, isLostWatch, linkIn, notesFile, parseNotes, published, withNote, type Published,
} from '../hooks/artifacts'
import { browserText, usesBrowser } from '../hooks/browser'
import { followUpText } from '../hooks/usage'
import { ROOT, SESSION, START, SUPERVISED, SWITCH, endTurn, limits, startTurn, world } from './world'

const PAGE = 'https://claude.ai/code/artifact/0936afb2-629a-426c-9dfb-04f914e12dc6'
const BOARD = 'https://claude.ai/artifact/abc123'
const NOTE: Published = { url: PAGE, file: '/work/page.html', account: '1' }

describe('the artifacts a conversation published', () => {
  test('a publish this account owns is noted with its link, source file and account', () => {
    expect(published('Artifact', { file_path: '/work/page.html' }, { url: PAGE, path: 'p' }, '1')).toEqual(NOTE)
    expect(published('Artifact', { action: 'publish', file_path: '/work/page.html' }, { url: PAGE, owned: true }, '1')).toEqual(NOTE)
    expect(published('Artifact', { type_url: 'https://claude.ai/artifact/t' }, { url: BOARD }, '2')).toEqual({ url: BOARD, file: '', account: '2' })
  })

  test("a publish to someone else's artifact, another action, another tool and a result with no link are not noted", () => {
    expect(published('Artifact', { file_path: '/x', url: PAGE }, { url: PAGE, owned: false }, '2')).toBeUndefined()
    expect(published('Artifact', { action: 'read', url: PAGE }, { url: PAGE }, '1')).toBeUndefined()
    expect(published('Artifact', { action: 'watch', url: PAGE }, { url: PAGE }, '1')).toBeUndefined()
    expect(published('Write', { file_path: '/x' }, { url: PAGE }, '1')).toBeUndefined()
    expect(published('Artifact', { file_path: '/x' }, { url: 'https://example.com/artifact/1' }, '1')).toBeUndefined()
    expect(published('Artifact', { file_path: '/x' }, undefined, '1')).toBeUndefined()
  })

  test('a later publish of the same artifact replaces its note; another artifact is added', () => {
    const moved = { ...NOTE, file: '/work/new.html' }
    expect(withNote([NOTE], moved)).toEqual([moved])
    expect(withNote([NOTE], { url: BOARD, file: '', account: '2' })).toEqual([NOTE, { url: BOARD, file: '', account: '2' }])
  })

  test('a notes file is read back whole, and one that is not a list of notes is refused', () => {
    expect(parseNotes(JSON.stringify([NOTE]))).toEqual([NOTE])
    expect(parseNotes('[]')).toEqual([])
    expect(parseNotes('[{"url":"https://claude.ai/code/artifact/x"')).toBeUndefined()
    expect(parseNotes('{"url":"x"}')).toBeUndefined()
    expect(parseNotes(JSON.stringify([{ ...NOTE, url: 'https://example.com/x' }]))).toBeUndefined()
    expect(parseNotes(JSON.stringify([{ ...NOTE, account: '' }]))).toBeUndefined()
    expect(parseNotes(JSON.stringify([{ url: PAGE, account: '1' }]))).toBeUndefined()
  })

  test('the artifacts left behind are those another account owns', () => {
    const notes = [NOTE, { url: BOARD, file: '', account: '2' }]
    expect(elsewhere(notes, '2')).toEqual([NOTE])
    expect(elsewhere(notes, '3')).toEqual(notes)
    expect(elsewhere([], '1')).toEqual([])
  })

  test('a moved conversation is told which artifacts stayed on which account, and what keeps each', () => {
    expect(artifactsText([NOTE], '1')).toBeUndefined()
    expect(artifactsText([], '2')).toBeUndefined()
    const one = artifactsText([NOTE], '2') ?? ''
    expect(one).toContain(`This conversation published this artifact on another account, and the 2 account does not own it: ${PAGE} (owned by 1, source /work/page.html).`)
    expect(one).toContain('read it first')
    expect(one).toContain('press Share and give the whole organization edit access (or add this account as an editor)')
    expect(one).toContain('do not try again')
    const two = artifactsText([NOTE, { url: BOARD, file: '', account: '3' }], '2') ?? ''
    expect(two).toContain(`these artifacts on another account, and the 2 account does not own them: ${PAGE} (owned by 1, source /work/page.html), ${BOARD} (owned by 3).`)
  })

  test("an Artifact call on another account's artifact reads who owns it; a call on one of its own or on none reads nothing", () => {
    expect(callContext({ action: 'watch', url: PAGE }, [NOTE], '2')).toContain(`cc-accounts: this conversation published ${PAGE} (owned by 1, source /work/page.html), and it now runs on the 2 account.`)
    expect(callContext({ action: 'watch', url: PAGE }, [NOTE], '1')).toBeUndefined()
    expect(callContext({ action: 'list' }, [NOTE], '2')).toBeUndefined()
    expect(callContext({ url: BOARD }, [NOTE], '2')).toBeUndefined()
  })

  test('a watch of an artifact left behind is not work a move can start again', () => {
    expect(linkIn(`live updates for artifact ${PAGE} (re-armed on session resume)`)).toBe(PAGE)
    expect(linkIn('npm test')).toBeUndefined()
    expect(isLostWatch(`live updates for artifact ${PAGE} (re-armed on session resume)`, [NOTE])).toBe(true)
    expect(isLostWatch(`live updates for artifact ${BOARD}`, [NOTE])).toBe(false)
    expect(isLostWatch('npm test', [NOTE])).toBe(false)
  })
})

describe('the browser extension after a move', () => {
  test('only the Chrome extension tools are browser tools', () => {
    expect(usesBrowser('mcp__claude-in-chrome__navigate')).toBe(true)
    expect(usesBrowser('mcp__playwright__browser_click')).toBe(false)
    expect(usesBrowser('Bash')).toBe(false)
  })

  test('a conversation that used them is told the extension is tied to an account and how to go on', () => {
    const text = browserText('2')
    expect(text).toContain('signed in to the 2 account')
    expect(text).toContain('list_connected_browsers')
  })
})

describe('what a moved conversation is told', () => {
  const move = { from: '1', to: '2', interrupted: false, stop: { window: 'five_hour' }, stopped: ['shell "npm test"'] }

  test('the artifacts left behind and the browser follow the work to start again', () => {
    expect(followUpText({ ...move, left: [NOTE], browser: true })).toBe(
      '[cc-accounts] The 1 account reached its 5-hour usage limit and stopped your last turn. ' +
        'This conversation now runs on the 2 account. Carry on from where you stopped. ' +
        'The move stopped this background work, so start again whatever of it is still needed: shell "npm test". ' +
        `${artifactsText([NOTE], '2')} ${browserText('2')}`,
    )
  })

  test('with none left behind and no browser used, nothing is added', () => {
    expect(followUpText({ ...move, left: [], browser: false })).toBe(followUpText(move))
    expect(followUpText({ ...move, left: [{ ...NOTE, account: '2' }] })).toBe(followUpText(move))
  })

  test('a move that interrupted nothing still starts no turn for them', () => {
    expect(followUpText({ from: '1', to: '2', interrupted: false, stop: undefined, stopped: [], left: [NOTE], browser: true })).toBeUndefined()
  })
})

describe('a session and its artifacts', () => {
  const publish = { tool: 'Artifact', file_path: '/work/page.html' } as never
  const watch = { tool: 'Artifact', action: 'watch', url: PAGE } as never
  const WATCH = { id: 'm1', type: 'monitor', description: `live updates for artifact ${PAGE} (re-armed on session resume)` }

  test('a publish is noted under the account it ran on, in a file every account shares', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    w.results.set('Artifact', { url: PAGE, path: 'page' })
    await $.tool.call(publish)
    expect(parseNotes(w.files.get(notesFile(ROOT, SESSION)) ?? '')).toEqual([NOTE])
  })

  test('an Artifact call on an artifact another account owns carries who owns it; one on its own carries nothing', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.files.set(notesFile(ROOT, SESSION), JSON.stringify([{ ...NOTE, account: '2' }]))
    await $.session.start(START)
    w.results.set('Artifact', { url: PAGE })
    const answer = await $.tool.call(watch)
    expect(answer.context?.join(' ')).toContain(`${PAGE} (owned by 2, source /work/page.html), and it now runs on the 1 account`)
    w.files.set(notesFile(ROOT, SESSION), JSON.stringify([NOTE]))
    expect((await $.tool.call(watch)).context).toBeUndefined()
  })

  test('a notes file that is not one costs the call nothing: it is reported and written afresh', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.files.set(notesFile(ROOT, SESSION), 'not json')
    await $.session.start(START)
    w.results.set('Artifact', { url: PAGE, path: 'page' })
    expect((await $.tool.call(publish)).result).toEqual({ url: PAGE, path: 'page' })
    expect(parseNotes(w.files.get(notesFile(ROOT, SESSION)) ?? '')).toEqual([NOTE])
  })

  test('a move its account forced says which artifacts stayed, leaves their watches out of the work to start again, and names the browser it used', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    w.results.set('Artifact', { url: PAGE, path: 'page' })
    await $.tool.call(publish)
    w.results.set('mcp__claude-in-chrome__navigate', { ok: true })
    await $.tool.call({ tool: 'mcp__claude-in-chrome__navigate', url: 'https://example.com' } as never)
    await endTurn($, w, await startTurn($), [WATCH, { id: 'b1', type: 'shell', description: 'npm test' }])
    limits(w, 100)
    await endTurn($, w, await startTurn($))
    await w.clock.advance(0)
    const asked = w.files.get(SWITCH) ?? ''
    expect(asked).toContain('start again whatever of it is still needed: shell "npm test".')
    expect(asked).toContain(artifactsText([NOTE], '2') ?? 'none')
    expect(asked).toContain(browserText('2'))
  })
})
