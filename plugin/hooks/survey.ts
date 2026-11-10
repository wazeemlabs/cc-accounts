// What a session can learn of every account and of the sessions running on
// them, for the balancer's decisions and /account usage: each account's last
// rate-limit reading (usage/<account>.json, written by whichever of its
// sessions measured last), its login and plan size, and the live sessions,
// each with the folder it started in.
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
// the folder it started in, the name its tab shows, and whether it is
// working (`active`): busy now, or idle for less than ACTIVE_MS. An idle
// session spends nothing on its account until a person writes to it.
export type LiveSession = { sessionId: string; account: string; cwd: string; name: string; active: boolean }

// How long after its last turn a session still counts as working: a person
// answering, or a background task's report, starts its next turn.
export const ACTIVE_MS = 30 * 60_000

// The live sessions: Claude Code's session list (shared by every account),
// each entry's conversation as cca recorded it, and one `ps` for which of
// their processes still run.
export async function liveSessions($: EngineInterface, ctx: Context): Promise<LiveSession[]> {
  const dir = `${ctx.shared}/sessions`
  if (!(await $.fs.exists(dir))) return []
  const now = await $.clock.now()
  const entries: { pid: number; sessionId: string; cwd: string; name: string; active: boolean }[] = []
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    let value: unknown
    try {
      value = JSON.parse(await $.fs.read(`${dir}/${entry.name}`))
    } catch {
      // An entry caught mid-write or gone since the listing: one session fewer counted.
      continue
    }
    if (isObject(value) && typeof value.pid === 'number' && typeof value.sessionId === 'string') {
      entries.push({
        pid: value.pid,
        sessionId: value.sessionId,
        cwd: typeof value.cwd === 'string' ? value.cwd : '',
        name: typeof value.name === 'string' ? value.name : '',
        active: activeOf(value.status, value.statusUpdatedAt, now),
      })
    }
  }
  if (entries.length === 0) return []
  const { stdout } = await run($, ['ps', '-o', 'pid=', '-p', entries.map(entry => entry.pid).join(',')])
  const alive = new Set(stdout.split('\n').map(line => line.trim()).filter(line => line !== ''))
  const live: LiveSession[] = []
  for (const entry of entries) {
    if (!alive.has(String(entry.pid))) continue
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
