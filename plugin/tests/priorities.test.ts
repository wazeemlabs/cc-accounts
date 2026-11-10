import { describe, expect, test } from 'claude-code/testing'
import {
  formatPriorities,
  heavierOn,
  loads,
  normalizeFolder,
  parsePriorities,
  parseWeight,
  projectName,
  weightOf,
} from '../hooks/priorities'
import { activeOf, ACTIVE_MS, type LiveSession } from '../hooks/survey'

const at = (sessionId: string, account: string, cwd: string): LiveSession => ({ sessionId, account, cwd, name: '', active: true })
const WEIGHTS = new Map([['/p/app', 3], ['/p/app/docs', 0.5], ['/p/misc', 2]])

describe('project weights', () => {
  test('a weight is a number above 0 and at most 100', () => {
    expect(parseWeight('3')).toBe(3)
    expect(parseWeight('0.5')).toBe(0.5)
    expect(parseWeight('100')).toBe(100)
    for (const bad of ['0', '0.0', '-1', '101', '1e2', 'three', '', '3x', '.5']) expect(parseWeight(bad)).toBe(undefined)
  })

  test('a folder is keyed absolute, with ~ expanded and no trailing slash', () => {
    expect(normalizeFolder('~/code/app/', '/Users/me')).toBe('/Users/me/code/app')
    expect(normalizeFolder('~', '/Users/me')).toBe('/Users/me')
    expect(normalizeFolder('/srv/My Project//', '/Users/me')).toBe('/srv/My Project')
    expect(normalizeFolder('/', '/Users/me')).toBe('/')
    expect(normalizeFolder('code/app', '/Users/me')).toBe(undefined)
    expect(normalizeFolder('~other/app', '/Users/me')).toBe(undefined)
  })

  test('a folder typed with . and .. is keyed as the folder it names', () => {
    expect(normalizeFolder('/srv/a/../b/./c', '/Users/me')).toBe('/srv/b/c')
    expect(normalizeFolder('~/code/..', '/Users/me')).toBe('/Users/me')
    expect(normalizeFolder('/srv//a///b', '/Users/me')).toBe('/srv/a/b')
    expect(normalizeFolder('/..', '/Users/me')).toBe('/')
  })

  test('the file round-trips, and anything but absolute folders with weights in range is refused', () => {
    expect(parsePriorities(formatPriorities(WEIGHTS))).toEqual(WEIGHTS)
    expect(parsePriorities('{}')).toEqual(new Map())
    for (const bad of ['[]', '{"rel/dir": 2}', '{"/a": 0}', '{"/a": 101}', '{"/a": "2"}', '{"/a":', 'null']) {
      expect(parsePriorities(bad)).toBe(undefined)
    }
  })

  test('a session takes the weight of the nearest folder at or above where it started, else 1', () => {
    expect(weightOf(WEIGHTS, '/p/app')).toEqual({ weight: 3, folder: '/p/app' })
    expect(weightOf(WEIGHTS, '/p/app/src/ui')).toEqual({ weight: 3, folder: '/p/app' })
    expect(weightOf(WEIGHTS, '/p/app/docs/api')).toEqual({ weight: 0.5, folder: '/p/app/docs' })
    expect(weightOf(WEIGHTS, '/p/application')).toEqual({ weight: 1, folder: undefined })
    expect(weightOf(WEIGHTS, '')).toEqual({ weight: 1, folder: undefined })
    expect(weightOf(new Map([['/', 2]]), '/anything')).toEqual({ weight: 2, folder: '/' })
  })

  test("an account's load sums its sessions' weights", () => {
    const live = [at('1', 'a', '/p/app'), at('2', 'a', '/p/other'), at('3', 'b', '/p/app/docs')]
    expect(loads(live, WEIGHTS)).toEqual(new Map([['a', 4], ['b', 0.5]]))
  })

  test('a session works while busy, or idle less than half an hour, or with no status recorded', () => {
    expect(activeOf('busy', 0, ACTIVE_MS * 10)).toBe(true)
    expect(activeOf(undefined, undefined, 0)).toBe(true)
    expect(activeOf('idle', 1000, 1000 + ACTIVE_MS - 1)).toBe(true)
    expect(activeOf('idle', 1000, 1000 + ACTIVE_MS)).toBe(false)
    expect(activeOf('idle', undefined, 0)).toBe(true)
  })

  test('an idle session weighs on no account', () => {
    const live = [at('1', 'a', '/p/app'), { ...at('2', 'a', '/p/other'), active: false }]
    expect(loads(live, WEIGHTS)).toEqual(new Map([['a', 3]]))
  })

  test('finds the heaviest other session on the account that outweighs this one', () => {
    const live = [at('me', 'a', '/p/x'), at('2', 'a', '/p/misc'), at('3', 'a', '/p/app/src'), at('4', 'b', '/p/app')]
    expect(heavierOn(live, WEIGHTS, 'a', 'me', 1)).toEqual({ session: live[2], weight: 3, folder: '/p/app' })
    expect(heavierOn(live, WEIGHTS, 'a', 'me', 3)).toBe(undefined)
    expect(heavierOn(live, WEIGHTS, 'a', '3', 3)).toBe(undefined)
    expect(heavierOn(live, WEIGHTS, 'c', 'me', 1)).toBe(undefined)
    // An idle heavier session is passed over.
    expect(heavierOn([live[0]!, { ...live[2]!, active: false }], WEIGHTS, 'a', 'me', 1)).toBe(undefined)
  })

  test('a project is named by the last part of its folder', () => {
    expect(projectName('/Users/me/code/My App')).toBe('My App')
    expect(projectName('/Users/me/code/app/')).toBe('app')
    expect(projectName('/')).toBe('/')
  })
})
