import { describe, expect, test } from 'claude-code/testing'
import { stopOf } from '../hooks/balance'
import { failureIn, familyOf, scopeOf } from '../hooks/failures'

const row = (value: object) => JSON.stringify(value)
const reply = row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } })
const failed = (error: string) => row({ type: 'assistant', isApiErrorMessage: true, error, message: { role: 'assistant', content: [] } })

describe('why the last turn failed, from the transcript', () => {
  test("reads the error word of the last assistant row when it is Claude Code's API-error row", () => {
    expect(failureIn([reply, failed('rate_limit'), row({ type: 'system', subtype: 'turn_duration' })].join('\n'))).toBe('rate_limit')
    expect(failureIn(failed('authentication_failed'))).toBe('authentication_failed')
  })

  test('an error an earlier turn ended on, followed by a reply, is not this turn\'s', () => {
    expect(failureIn([failed('rate_limit'), row({ type: 'user', message: {} }), reply].join('\n'))).toBe(undefined)
  })

  test('nothing to read is no failure: no rows, a header, a line tail cut, a row without a word', () => {
    expect(failureIn('')).toBe(undefined)
    expect(failureIn(`==> x.jsonl <==\n{"type":"assist`)).toBe(undefined)
    expect(failureIn(row({ type: 'assistant', isApiErrorMessage: true, error: '' }))).toBe(undefined)
    expect(failureIn(row({ type: 'assistant', isApiErrorMessage: true }))).toBe(undefined)
    expect(failureIn(row({ type: 'assistant', error: 'rate_limit' }))).toBe(undefined)
  })
})

describe('which model family a limit covers', () => {
  test('reads the family from a full model id or an alias, a context suffix and case aside', () => {
    expect(familyOf('claude-opus-4-6')).toBe('opus')
    expect(familyOf('claude-fable-5-1')).toBe('fable')
    expect(familyOf('claude-3-5-sonnet-20241022')).toBe('sonnet')
    expect(familyOf('claude-mythos-preview')).toBe('mythos')
    expect(familyOf('opus[1m]')).toBe('opus')
    expect(familyOf(' Fable ')).toBe('fable')
    expect(familyOf('haiku')).toBe('haiku')
  })

  test('an alias that names no one family, or a name that is no model, has none', () => {
    for (const name of ['default', 'best', 'opusplan', '', 'gpt-4o', 'claude-', 'claude-4-5']) expect(familyOf(name)).toBe(undefined)
  })

  test('a usage limit is recorded for its family when known; every other failure for the account', () => {
    expect(scopeOf('rate_limit', 'fable')).toBe('fable')
    expect(scopeOf('rate_limit', undefined)).toBe('account')
    expect(scopeOf('authentication_failed', 'fable')).toBe('account')
  })
})

describe('what stopped a failed turn', () => {
  test('an account failure the readings do not explain, else a window at its limit', () => {
    expect(stopOf('rate_limit', undefined)).toEqual({ error: 'rate_limit' })
    expect(stopOf('rate_limit', 'five_hour')).toEqual({ window: 'five_hour' })
    expect(stopOf('authentication_failed', 'five_hour')).toEqual({ error: 'authentication_failed' })
    expect(stopOf('overloaded', 'seven_day')).toEqual({ window: 'seven_day' })
    expect(stopOf('overloaded', undefined)).toBe(undefined)
    expect(stopOf(undefined, undefined)).toBe(undefined)
  })
})
