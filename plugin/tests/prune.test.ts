import { describe, expect, test } from 'claude-code/testing'
import { HOME, ROOT, SESSION, START, SUPERVISED, cost, turn, world } from './world'

const PROJECTS = `${HOME}/.claude-shared/projects`
const common = ['--projects', PROJECTS, '--lock', `${ROOT}/prune.lock`, '--state', `${ROOT}/prune-state.json`]
const summary = (count: number) =>
  `cc-accounts: pruned ${count} transcript${count === 1 ? '' : 's'} to save space; the debug log lists them.`

// What a compaction leaves: at least one message.
const KEPT = [{ role: 'user' as const, text: 'the summary', toolUses: [] }]

describe('transcripts are pruned', () => {
  test('a session prunes every transcript that changed when it starts, without waiting for it', async ($, on) => {
    const w = world(on, SUPERVISED)
    await $.session.start(START)
    await w.prunes.started(1)
    const [python, script, ...rest] = w.prunes.argv[0]!
    expect(python).toBe('python3')
    expect(script!.endsWith('/hooks/prune.py')).toBe(true)
    expect(rest).toEqual([...common, '--all'])
    await Promise.all(w.prunes.ended)
    // Nothing was shrunk: nothing is said.
    expect(w.logs.some(line => line.includes('prune'))).toBe(false)
  })

  test("after a compaction, this conversation's transcripts are pruned once the main turn ends", async ($, on) => {
    const w = world(on, SUPERVISED)
    on('session.compact', async (_$, e) => ({ messages: e.messages }))
    await $.session.start(START)
    await $.session.compact({ trigger: 'auto', messages: KEPT })
    await w.prunes.started(1)
    // A subagent's turn ending is not the main turn's.
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'a1', reason: 'answer', agentId: 'a', usage: cost('claude-opus-5-5', 1) })
    expect(w.prunes.argv).toHaveLength(1)
    await turn($, w, [])
    await w.prunes.started(2)
    expect(w.prunes.argv[1]!.slice(2)).toEqual([...common, '--session', SESSION])
    // Once per compaction: the next turn's end starts none, and a session
    // start's prune would be the third.
    await turn($, w, [])
    await $.session.start(START)
    await w.prunes.started(3)
    expect(w.prunes.argv[2]!.slice(2)).toEqual([...common, '--all'])
  })

  test('a compaction skipped or only precomputed prunes nothing', async ($, on) => {
    const w = world(on, SUPERVISED)
    on('session.compact', async (_$, e) => (e.trigger === 'manual' ? { skip: 'not now' } : { messages: e.messages }))
    await $.session.start(START)
    await $.session.compact({ trigger: 'manual', messages: KEPT })
    await $.session.compact({ trigger: 'precompute', messages: KEPT })
    await turn($, w, [])
    // The next prune started is a session start's, not one for a compaction.
    await $.session.start(START)
    await w.prunes.started(2)
    expect(w.prunes.argv.map(argv => argv.at(-1))).toEqual(['--all', '--all'])
  })

  test('each transcript shrunk goes to the debug log, a line cut across pieces counted once, and one line to the transcript', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.prunes.chunks.push(
      { stream: 'stdout', text: '/p/a.jsonl: 977 MB -> 127 MB\n/p/b.js' },
      { stream: 'stdout', text: 'onl: 27 MB -> 2 MB\n' },
    )
    await $.session.start(START)
    await w.logged(line => line === summary(2))
    expect(w.debug).toEqual(['cc-accounts: pruned /p/a.jsonl: 977 MB -> 127 MB', 'cc-accounts: pruned /p/b.jsonl: 27 MB -> 2 MB'])
    expect(w.logs.filter(line => line.includes('pruned'))).toEqual([summary(2)])
  })

  test('a prune that fails says why in the transcript', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.prunes.chunks.push({ stream: 'stderr', text: 'cc-accounts: could not prune /p/a.jsonl (Permission denied)\n' })
    w.prunes.code = 1
    await $.session.start(START)
    await w.logged(line => line.startsWith('cc-accounts: could not prune transcripts'))
    expect(w.logs.at(-1)).toBe('cc-accounts: could not prune transcripts (cc-accounts: could not prune /p/a.jsonl (Permission denied)).')
  })

  test('a prune that fails without a word gives its exit code', async ($, on) => {
    const w = world(on, SUPERVISED)
    w.prunes.code = 2
    await $.session.start(START)
    await w.logged(line => line.startsWith('cc-accounts: could not prune transcripts'))
    expect(w.logs.at(-1)).toBe('cc-accounts: could not prune transcripts (exit 2).')
  })

  for (const [how, code, signal] of [['its handler exits 143', 143, null], ['it dies of the signal', null, 'SIGTERM']] as const) {
    test(`a prune stopped by SIGTERM, as a reload of the plugin stops it, is no failure when ${how}: the debug log says so`, async ($, on) => {
      const w = world(on, SUPERVISED)
      w.prunes.code = code
      w.prunes.signal = signal
      await $.session.start(START)
      await w.logged(line => line === 'cc-accounts: a transcript prune was stopped; the next session start carries on.')
      expect(w.logs.some(line => line.includes('could not prune'))).toBe(false)
    })
  }

  test('CCA_PRUNE=off prunes nothing', async ($, on) => {
    const w = world(on, { ...SUPERVISED, CCA_PRUNE: 'off' })
    on('session.compact', async (_$, e) => ({ messages: e.messages }))
    await $.session.start(START)
    await $.session.compact({ trigger: 'auto', messages: KEPT })
    await turn($, w, [])
    // The session start's prune and the compaction's each say so, and start nothing.
    await w.logged(line => line === 'cc-accounts: transcripts are not pruned (CCA_PRUNE=off).', 2)
    expect(w.prunes.argv).toHaveLength(0)
  })
})
