// A move in VS Code keeps the panel's process. 0.14.0 let the process end
// after a move so the panel would start the conversation again with its own
// startup and show the new account; but the panel shows a conversation whose
// process ended as stopped until the next message, so sessions looked idle or
// disconnected right after finishing a turn. A relaunched process ended at the
// first turn end with no background work, which came hours after the move
// (2026-11-16: a move at 01:50, the session ended at 07:09 on the account it
// had worked on since), so it looked like it happened with no move at all.
// Now every move is a relaunch in place, and a relaunched process runs on.
// CCA_STREAM_FRESH and CCA_STREAM_RESUMED are what a cca-stream before 0.15.0
// still gives its children.
import { describe, expect, test } from 'claude-code/testing'
import { SELF, SESSION, START, SUPERVISED, SWITCH, limits, turn, world } from './world'

const OLD_STREAM = { ...SUPERVISED, CCA_STREAM_FRESH: '1' }
const OLD_RELAUNCH = { ...OLD_STREAM, CCA_STREAM_RESUMED: '1' }
const SIGINT = ['kill', '-INT', SELF]

describe("a move in VS Code keeps the panel's process", () => {
  for (const [name, env] of [
    ['under cca-stream', SUPERVISED],
    ['under a cca-stream before 0.15.0, which offered to end with the process', OLD_STREAM],
  ] as const) {
    test(`${name}: a move with nothing to carry on relaunches the conversation in place`, async ($, on) => {
      const w = world(on, env)
      await $.session.start(START)
      limits(w, 91)
      await turn($, w, [])
      await w.clock.advance(0)
      expect(w.files.get(SWITCH)).toBe(`2 ${SESSION}\n`)
      expect(w.killed).toEqual([SIGINT])
    })
  }

  test('a process a move relaunched stays open at the end of its turns on its own account', async ($, on) => {
    const w = world(on, OLD_RELAUNCH)
    await $.session.start(START)
    limits(w, 40)
    await turn($, w, [])
    await w.clock.advance(0)
    await turn($, w, [])
    await w.clock.advance(0)
    expect(w.files.has(SWITCH)).toBe(false)
    expect(w.killed).toEqual([])
  })
})
