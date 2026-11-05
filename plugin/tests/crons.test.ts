import { describe, expect, test } from 'claude-code/testing'
import { cronsOf } from '../hooks/crons'

describe('the wakeups CronList lists', () => {
  test("keeps the session's own jobs with their whole prompts, and leaves those that outlive the process", () => {
    const long = 'check the build and report. '.repeat(60)
    expect(cronsOf({
      jobs: [
        { id: 'a', cron: '*/5 * * * *', humanSchedule: 'Every 5 minutes', prompt: long, recurring: true, durable: false },
        { id: 'b', cron: '30 14 6 11 *', humanSchedule: 'once', prompt: 'look again', durable: false },
        { id: 'c', cron: '0 9 * * *', humanSchedule: 'Every day at 9', prompt: 'saved to disk' },
      ],
    })).toEqual([
      { schedule: '*/5 * * * *', recurring: true, prompt: long },
      { schedule: '30 14 6 11 *', recurring: false, prompt: 'look again' },
    ])
    expect(long.length).toBeGreaterThan(1000)
  })

  test('an empty list is no wakeups, and any other shape is unknown', () => {
    expect(cronsOf({ jobs: [] })).toEqual([])
    for (const bad of [undefined, null, 'jobs', {}, { jobs: 'a' }, { jobs: [{ id: 'a', durable: false }] }, { jobs: [null] }]) {
      expect(cronsOf(bad)).toBe(undefined)
    }
  })
})
