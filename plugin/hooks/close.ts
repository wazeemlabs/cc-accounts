// /account close: ends other sessions' processes to free their memory, when
// a person asks. A session that is working, or whose last turn's end listed
// background work, is closed only with `now`; this session never (it has
// /exit). The conversation stays and reopens later.
import type { EngineInterface } from 'claude-code'
import { describeError, run, type Context } from './context'
import { gatherSessions, memoryText, span, LONG_IDLE_MS, type SessionRow } from './sessions'
import { endProcess } from './switching'

export const STALE = 'stale'

const label = (row: SessionRow) => row.name || row.sessionId.slice(0, 8)

// The sessions `target` names: the one whose id starts with it, else those
// whose name is it, else those whose name starts with it, letter case aside.
export function named(rows: readonly SessionRow[], target: string): SessionRow[] {
  const wanted = target.toLowerCase()
  const byId = rows.filter(row => wanted.length >= 4 && row.sessionId.toLowerCase().startsWith(wanted))
  if (byId.length > 0) return byId
  const exact = rows.filter(row => row.name.toLowerCase() === wanted)
  return exact.length > 0 ? exact : rows.filter(row => row.name !== '' && row.name.toLowerCase().startsWith(wanted))
}

// Idle for over a day with no background work listed, and not this session.
export function stale(rows: readonly SessionRow[], thisSession: string): SessionRow[] {
  return rows.filter(row => row.sessionId !== thisSession && (row.idleMs ?? 0) >= LONG_IDLE_MS && row.tasks === 0)
}

// Why a session is not closed without `now`, or undefined when nothing it
// runs would be lost.
export function busy(row: SessionRow): string | undefined {
  if (row.idleMs === undefined) return 'is working'
  return row.tasks === 0 ? undefined : `runs ${row.tasks} background task${row.tasks === 1 ? '' : 's'}`
}

// The processes among `pids` that still run with no session above them: left
// behind by the session that started them.
async function leftBehind($: EngineInterface, pids: readonly number[]): Promise<number[]> {
  if (pids.length === 0) return []
  const { stdout } = await run($, ['ps', '-o', 'pid=,ppid=', '-p', pids.join(',')])
  const known = new Set(pids)
  return stdout.split('\n').flatMap(line => {
    const [pid, parent] = line.trim().split(/\s+/).map(Number)
    return pid !== undefined && parent !== undefined && known.has(pid) && (parent === 1 || known.has(parent)) ? [pid] : []
  })
}

// Ends one session's process, then the helpers it left behind. undefined when
// it ended; else why it still runs.
async function close($: EngineInterface, row: SessionRow): Promise<string | undefined> {
  const failure = await endProcess($, String(row.pid), async () => {})
  if (failure !== undefined) return failure
  for (const pid of await leftBehind($, row.helperPids)) {
    // Gone by itself meanwhile is as good.
    await run($, ['kill', '-TERM', String(pid)])
  }
  return undefined
}

// Closes `rows` side by side and logs what came of each: it runs from a
// timer, after the command has answered, since ending a process takes
// seconds.
export async function closeAll($: EngineInterface, rows: readonly SessionRow[]): Promise<void> {
  const results = await Promise.all(rows.map(async row => {
    try {
      return await close($, row)
    } catch (error) {
      return describeError(error)
    }
  }))
  const closed = rows.filter((_, index) => results[index] === undefined)
  if (closed.length > 0) {
    const freed = closed.reduce((sum, row) => sum + row.ownKb + row.helperKb, 0)
    $.ui.log(`cc-accounts: closed ${closed.map(label).join(', ')}: about ${memoryText(freed)} freed.`)
  }
  for (const [index, row] of rows.entries()) {
    if (results[index] !== undefined) $.ui.log(`cc-accounts: could not close ${label(row)} (${results[index]}); it runs on.`)
  }
}

export async function closeCommand($: EngineInterface, ctx: Context, target: string, force: boolean): Promise<string> {
  const rows = await gatherSessions($, ctx)
  const here = await $.session.id()
  let chosen: SessionRow[]
  if (target === STALE) {
    chosen = stale(rows, here)
    if (chosen.length === 0) return 'No other session has been idle for over a day with nothing running. /account sessions lists them all.'
  } else {
    const found = named(rows, target)
    if (found.length === 0) return `No running session is named ${target}, or has an id that starts with it. /account sessions lists them.`
    if (found.length > 1) {
      return `${found.length} sessions match ${target}: ${found.map(row => `${label(row)} (${row.sessionId.slice(0, 8)})`).join(', ')}. Name one by its id.`
    }
    const [row] = found as [SessionRow]
    if (row.sessionId === here) return 'That is this session: type /exit to close it.'
    const why = busy(row)
    if (why !== undefined && !force) {
      return `${label(row)} ${why}, which closing it would stop. To close it anyway, type /account close ${target} now.`
    }
    chosen = [row]
  }
  await $.clock.after(0, () => closeAll($, chosen))
  const held = chosen.reduce((sum, row) => sum + row.ownKb + row.helperKb, 0)
  const list = chosen.map(row => `${label(row)} (${row.idleMs === undefined ? 'working' : `idle ${span(row.idleMs)}`})`).join(', ')
  return `Closing ${list}, holding ${memoryText(held)}. Each conversation stays and reopens from the app's or the editor's list, ` +
    'or with `claude --resume <id>`; a line here says when it is done.'
}
