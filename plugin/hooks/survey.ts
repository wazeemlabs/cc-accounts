// What a session can learn of every account and of the sessions running on
// them, for the balancer's decisions and /account usage: each account's last
// rate-limit reading (usage/<account>.json, written by whichever of its
// sessions measured last), its login and plan size, and the live sessions,
// each with the folder it works in.
import type { EngineInterface } from 'claude-code'
import { configFileOf, emailIn, tierIn, unitsOfTier, type Account } from './accounts'
import { run, writeAtomic, type Context } from './context'
import { formatReading, parseReading, readingOf, type Reading } from './usage'

export function usageFile(root: string, account: string): string {
  return `${root}/usage/${account}.json`
}

export async function readReading($: EngineInterface, root: string, account: string): Promise<Reading | undefined> {
  const file = usageFile(root, account)
  if (!(await $.fs.exists(file))) return undefined
  return parseReading(await $.fs.read(file))
}

// This session's reading of its own account, as its last response gave it;
// undefined before the first response or off a subscription.
export async function ownReading($: EngineInterface, account: string): Promise<Reading | undefined> {
  const { rateLimits } = await $.session.usage()
  return rateLimits.length === 0 ? undefined : readingOf(account, await $.clock.now(), rateLimits)
}

// Every session on the account rewrites this file while others read it.
export async function writeReading($: EngineInterface, root: string, reading: Reading): Promise<void> {
  await writeAtomic($, usageFile(root, reading.account), formatReading(reading))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A session running now: its conversation, the account cca recorded for it,
// the folder it works in, the name its tab shows, and whether it is
// working (`active`): busy now, or idle for less than ACTIVE_MS. An idle
// session spends nothing on its account until a person writes to it.
export type LiveSession = { sessionId: string; account: string; cwd: string; name: string; active: boolean }

// How long after its last turn a session still counts as working: a person
// answering, or a background task's report, starts its next turn.
export const ACTIVE_MS = 30 * 60_000

// `entrypoint`: how it was started (`claude-vscode`, `claude-desktop`, `cli`);
// `startedAt` and `idleSince`: when its process started and, for an idle one,
// when its last turn ended, where the entry says.
export type RunningEntry = {
  pid: number
  sessionId: string
  cwd: string
  name: string
  active: boolean
  entrypoint: string
  startedAt: number | undefined
  idleSince: number | undefined
}

// The sessions whose processes still run: Claude Code's session list
// (shared by every account), and one `ps` for which of their processes run.
export async function runningSessions($: EngineInterface, ctx: Context): Promise<RunningEntry[]> {
  return (await sessionList($, ctx)).running
}

// The running sessions, and whether a running process's entry could not be
// read: Claude Code rewrites an entry in place, so a read can catch it empty
// or half written, and that session cannot be told ended.
export async function sessionList($: EngineInterface, ctx: Context): Promise<{ running: RunningEntry[]; unread: boolean }> {
  const dir = `${ctx.shared}/sessions`
  if (!(await $.fs.exists(dir))) return { running: [], unread: false }
  const now = await $.clock.now()
  const entries: RunningEntry[] = []
  const unreadPids: string[] = []
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    let value: unknown
    try {
      value = JSON.parse(await $.fs.read(`${dir}/${entry.name}`))
    } catch {
      // An entry caught mid-write or gone since the listing: one session fewer
      // counted, and its pid, which names the file, checked below.
      const pid = /^([0-9]+)\.json$/.exec(entry.name)?.[1]
      if (pid !== undefined) unreadPids.push(pid)
      continue
    }
    if (isObject(value) && typeof value.pid === 'number' && typeof value.sessionId === 'string') {
      entries.push({
        pid: value.pid,
        sessionId: value.sessionId,
        cwd: typeof value.cwd === 'string' ? value.cwd : '',
        name: typeof value.name === 'string' ? value.name : '',
        active: activeOf(value.status, value.statusUpdatedAt, now),
        entrypoint: typeof value.entrypoint === 'string' ? value.entrypoint : '',
        startedAt: typeof value.startedAt === 'number' ? value.startedAt : undefined,
        idleSince: value.status === 'idle' && typeof value.statusUpdatedAt === 'number' ? value.statusUpdatedAt : undefined,
      })
    }
  }
  const pids = [...entries.map(entry => String(entry.pid)), ...unreadPids]
  if (pids.length === 0) return { running: [], unread: false }
  const { stdout } = await run($, ['ps', '-o', 'pid=', '-p', pids.join(',')])
  const alive = new Set(stdout.split('\n').map(line => line.trim()).filter(line => line !== ''))
  return { running: entries.filter(entry => alive.has(String(entry.pid))), unread: unreadPids.some(pid => alive.has(pid)) }
}

// How full this session's context window is, as a whole percentage; undefined
// before the first response of the live window (a fresh session, or one just
// compacted).
export async function ownContext($: EngineInterface): Promise<number | undefined> {
  return (await $.session.usage()).context.percent
}

// The live sessions cca recorded, each with the account it runs on.
export async function liveSessions($: EngineInterface, ctx: Context): Promise<LiveSession[]> {
  const live: LiveSession[] = []
  for (const entry of await runningSessions($, ctx)) {
    const file = `${ctx.root}/by-session/${entry.sessionId}`
    if (!(await $.fs.exists(file))) continue
    live.push({ sessionId: entry.sessionId, account: (await $.fs.read(file)).trim(), cwd: entry.cwd, name: entry.name, active: entry.active })
  }
  return live
}

// Whether a registry entry's session is working: anything but a known idle
// status counts, since an entry without one cannot be told apart from a busy
// session; an idle one counts until ACTIVE_MS after it went idle.
export function activeOf(status: unknown, since: unknown, now: number): boolean {
  if (status !== 'idle') return true
  return typeof since !== 'number' || now - since < ACTIVE_MS
}

// One account as every session sees it: who it is signed in as, how big its
// plan is in Max 5x plans (1 when the tier is unknown, `sized` false), and
// its last reading.
export type AccountState = {
  account: Account
  email: string | undefined
  units: number
  sized: boolean
  reading: Reading | undefined
}

export async function accountStates($: EngineInterface, ctx: Context): Promise<AccountState[]> {
  return Promise.all(
    ctx.accounts.map(async account => {
      const file = configFileOf(account, ctx.home)
      const config = (await $.fs.exists(file)) ? await $.fs.read(file) : undefined
      const tier = config === undefined ? undefined : tierIn(config)
      const units = tier === undefined ? undefined : unitsOfTier(tier)
      return {
        account,
        email: config === undefined ? undefined : emailIn(config),
        units: units ?? 1,
        sized: units !== undefined,
        reading: await readReading($, ctx.root, account.name),
      }
    }),
  )
}
