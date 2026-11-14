// Keeps transcripts small (hooks/prune.py): each drops the conversation from
// before its last compaction, and every image but its newest few. A session
// prunes, at its start, every transcript that changed since the last look,
// and after it compacts, its own. The prune runs as a child of the session,
// which never waits for it; one runs at a time on the machine, under a lock.
// CCA_PRUNE=off turns it off.
import type { EngineInterface } from 'claude-code'
import { describeError, type Context } from './context'

export type PruneTarget = { all: true } | { session: string }

export function pruneArgv(pluginRoot: string, ctx: Context, target: PruneTarget): string[] {
  return [
    'python3', `${pluginRoot}/hooks/prune.py`,
    '--projects', `${ctx.shared}/projects`,
    '--lock', `${ctx.root}/prune.lock`,
    '--state', `${ctx.root}/prune-state.json`,
    ...('all' in target ? ['--all'] : ['--session', target.session]),
  ]
}

// Starts a prune and resolves when it has ended. It reports what it shrank
// and any failure itself, and never rejects, so a caller need not wait.
export async function prune($: EngineInterface, ctx: Context, target: PruneTarget): Promise<void> {
  try {
    if ((await $.env.get('CCA_PRUNE')) === 'off') {
      $.ui.log('cc-accounts: transcripts are not pruned (CCA_PRUNE=off).', { to: 'debug' })
      return
    }
    const child = $.process.spawn({ argv: pruneArgv($.plugin.root, ctx, target), cwd: '/' })
    let errors = ''
    // The child prints a line per transcript shrunk; a piece of its output
    // can end mid-line.
    let pending = ''
    let shrunk = 0
    for await (const { stream, text } of child) {
      if (stream === 'stderr') {
        errors += text
        continue
      }
      const lines = (pending + text).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines.filter(line => line !== '')) {
        shrunk += 1
        $.ui.log(`cc-accounts: pruned ${line}`, { to: 'debug' })
      }
    }
    const { code, signal } = await child.result
    if (shrunk > 0) $.ui.log(`cc-accounts: pruned ${shrunk} transcript${shrunk === 1 ? '' : 's'} to their last compaction and newest images; the debug log lists them.`)
    if (code !== 0) {
      const why = errors.trim() || (signal === null ? `exit ${code}` : `ended by ${signal}`)
      $.ui.log(`cc-accounts: could not prune transcripts (${why}).`)
    }
  } catch (error) {
    $.ui.log(`cc-accounts: could not prune transcripts (${describeError(error)}).`)
  }
}

