import { describe, expect, test } from 'claude-code/testing'
import { failureIn } from '../hooks/failures'

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
