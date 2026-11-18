// /account sessions: every Claude Code session running on this machine, how
// long each has been idle, and the memory it and the processes it started
// hold, so a person can see which to close (close.ts). cca closes none by
// itself: ending a session stops its background work, and only its owner
// knows what that is worth.
import type { EngineInterface } from 'claude-code'
import { parseRecord } from './background'
import { run, type Context } from './context'
import { projectName } from './priorities'
import { untilText } from './report'
import { sessionList, type RunningEntry } from './survey'
import { recordFile } from './switching'

// A session idle this long is marked: nothing waits on it but its memory.
export const LONG_IDLE_MS = 24 * 60 * 60_000

export type SessionRow = {
  sessionId: string
  pid: number
  name: string
  project: string
  // undefined: a session cca has no record of.
  account: string | undefined
  where: string
  // How long since its last turn ended; undefined while it works.
  idleMs: number | undefined
  // undefined when its registry entry does not say when it started.
  upMs: number | undefined
  // The background work (subagents, shells, monitors) its last turn's end
  // listed, which closing it would stop; 0 for a session with no record.
  tasks: number
  // Resident memory, in KiB as ps reports it: the session's own process, and
  // every process under it (tool servers, shells and what they started).
  ownKb: number
  helpers: number
  helperKb: number
  helperPids: readonly number[]
}

type Process = { parent: number; kb: number }

// `ps -axo pid=,ppid=,rss=`: each process's parent and resident memory.
export function parseProcesses(text: string): Map<number, Process> {
  const found = new Map<number, Process>()
  for (const line of text.split('\n')) {
    const [pid, parent, kb, ...rest] = line.trim().split(/\s+/).map(Number)
    if (rest.length === 0 && [pid, parent, kb].every(value => Number.isInteger(value))) found.set(pid!, { parent: parent!, kb: kb! })
  }
  return found
}

// The processes under `root`, by its children's children. A pid ps listed as
// its own ancestor (reused between two lines of one listing) is counted once.
function under(processes: ReadonlyMap<number, Process>, root: number): number[] {
  const children = new Map<number, number[]>()
  for (const [pid, { parent }] of processes) children.set(parent, [...(children.get(parent) ?? []), pid])
  const seen = new Set<number>([root])
  const queue = [root]
  for (const pid of queue) {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }
  return queue.slice(1)
}

// Where a session runs, by the entrypoint Claude Code records for it.
function whereOf(entrypoint: string): string {
  if (entrypoint === 'claude-desktop') return 'desktop app'
  if (entrypoint === 'claude-vscode') return 'VS Code'
  return entrypoint === 'cli' || entrypoint === '' ? 'terminal' : entrypoint
}

// Idle longest first, then the working ones; within each, most memory first.
export function sessionRows(
  entries: readonly RunningEntry[],
  processes: ReadonlyMap<number, Process>,
  accounts: ReadonlyMap<string, string>,
  tasks: ReadonlyMap<string, number>,
  now: number,
): SessionRow[] {
  const rows = entries.map(entry => {
    const helpers = under(processes, entry.pid)
    return {
      sessionId: entry.sessionId,
      pid: entry.pid,
      name: entry.name,
      project: entry.cwd === '' ? '' : projectName(entry.cwd),
      account: accounts.get(entry.sessionId),
      where: whereOf(entry.entrypoint),
      idleMs: entry.idleSince === undefined ? undefined : Math.max(0, now - entry.idleSince),
      upMs: entry.startedAt === undefined ? undefined : Math.max(0, now - entry.startedAt),
      tasks: tasks.get(entry.sessionId) ?? 0,
      ownKb: processes.get(entry.pid)?.kb ?? 0,
      helpers: helpers.length,
      helperKb: helpers.reduce((sum, pid) => sum + (processes.get(pid)?.kb ?? 0), 0),
      helperPids: helpers,
    }
  })
  return rows.sort((a, b) => (b.idleMs ?? -1) - (a.idleMs ?? -1) || b.ownKb + b.helperKb - (a.ownKb + a.helperKb))
}

// `412 MB`, `3.2 GB`.
export function memoryText(kb: number): string {
  const mb = kb / 1024
  return mb < 1000 ? `${Math.round(mb)} MB` : `${(mb / 1024).toFixed(1)} GB`
}

export const span = (ms: number) => (ms < 60_000 ? 'under a minute' : untilText(ms, 0))
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

export function formatSessions(rows: readonly SessionRow[], thisSession: string | undefined): string {
  if (rows.length === 0) return 'No sessions are running.'
  const cells = rows.map(row => [
    row.name || row.sessionId.slice(0, 8),
    row.project || '-',
    row.account ?? '-',
    row.where,
    (row.idleMs === undefined ? 'working' : `idle ${span(row.idleMs)}`) + (row.tasks === 0 ? '' : `, ${row.tasks} in background`),
    row.upMs === undefined ? '-' : span(row.upMs),
    memoryText(row.ownKb),
    row.helpers === 0 ? '-' : `${row.helpers}, ${memoryText(row.helperKb)}`,
    [
      row.sessionId === thisSession ? '← this session' : '',
      (row.idleMs ?? 0) >= LONG_IDLE_MS ? '← idle over a day' : '',
    ].filter(note => note !== '').join(' '),
  ])
  const table = [['session', 'project', 'account', 'where', 'state', 'up', 'memory', 'helpers', ''], ...cells]
  const widths = table[0]!.map((_, column) => Math.max(...table.map(line => line[column]!.length)))
  const lines = table.map(line => line.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd())
  const own = rows.reduce((sum, row) => sum + row.ownKb, 0)
  const helperKb = rows.reduce((sum, row) => sum + row.helperKb, 0)
  const helpers = rows.reduce((sum, row) => sum + row.helpers, 0)
  const long = rows.filter(row => (row.idleMs ?? 0) >= LONG_IDLE_MS)
  const held = long.reduce((sum, row) => sum + row.ownKb + row.helperKb, 0)
  return [
    ...lines,
    '',
    `${plural(rows.length, 'session')}: ${memoryText(own)} in the sessions themselves, and ${memoryText(helperKb)} in ` +
      `${helpers} helper process${helpers === 1 ? '' : 'es'} (tool servers, shells and what they started).`,
    long.length === 0
      ? 'None has been idle for a day.'
      : `${long.length} idle for over a day hold${long.length === 1 ? 's' : ''} ${memoryText(held)}.`,
    'Close one with /account close <session name or id>, or every one idle for over a day and running nothing with ' +
      '/account close stale. Closing frees its memory and stops the work it runs in the background; the conversation ' +
      "stays, and reopens from the app's or the editor's list or with `claude --resume <id>`.",
  ].join('\n')
}

// What /account sessions shows, read now.
export async function gatherSessions($: EngineInterface, ctx: Context): Promise<SessionRow[]> {
  const { running } = await sessionList($, ctx)
  const { exitCode, stdout, stderr } = await run($, ['ps', '-axo', 'pid=,ppid=,rss='])
  if (exitCode !== 0) throw new Error(`ps failed: ${stderr.trim()}`)
  const accounts = new Map<string, string>()
  const tasks = new Map<string, number>()
  for (const entry of running) {
    const file = `${ctx.root}/by-session/${entry.sessionId}`
    if (await $.fs.exists(file)) accounts.set(entry.sessionId, (await $.fs.read(file)).trim())
    // As the session's last Stop hook left it; a turn in flight, or a record
    // caught half written, lists none.
    const record = recordFile(ctx.root, entry.sessionId)
    const found = (await $.fs.exists(record)) ? parseRecord(await $.fs.read(record)) : undefined
    if (found?.kind === 'tasks') tasks.set(entry.sessionId, found.tasks.length)
  }
  return sessionRows(running, parseProcesses(stdout), accounts, tasks, await $.clock.now())
}
