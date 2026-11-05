// Keeping sessions off accounts that are nearly spent. Each session writes
// its account's rate-limit readings to usage/<account>.json; at the end of
// each main-loop turn, a session whose account has a window at its leave
// threshold moves to the account with the most room (usage.ts decides which).
// A turn the limit itself stopped moves at once and reopens with a follow-up
// message, so the work carries on with nobody typing; otherwise the move waits
// for the session's background work, as /account does. CCA_BALANCE=off stops
// the moves; readings are still written.
import type { EngineInterface } from 'claude-code'
import type { Account } from './accounts'
import { context, emailOf, exitOf, type Context } from './context'
import { requestSwitch, waitingFor, type SwitchState } from './switching'
import { nameTask } from './background'
import {
  chooseTarget,
  describeUse,
  followUpText,
  formatReading,
  fullWindow,
  windowAtLimit,
  parseReading,
  readingOf,
  windowName,
  type Candidate,
  type Reading,
} from './usage'

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

export async function writeReading($: EngineInterface, root: string, reading: Reading): Promise<void> {
  await $.fs.write(usageFile(root, reading.account), formatReading(reading))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// How many live sessions run on each account: Claude Code's session list
// (shared by every account), each entry's conversation as cca recorded it,
// and one `ps` for which of their processes still run.
export async function liveSessions($: EngineInterface, ctx: Context): Promise<Map<string, number>> {
  const dir = `${ctx.shared}/sessions`
  const counts = new Map<string, number>()
  if (!(await $.fs.exists(dir))) return counts
  const entries: { pid: number; sessionId: string }[] = []
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
      entries.push({ pid: value.pid, sessionId: value.sessionId })
    }
  }
  if (entries.length === 0) return counts
  const { stdout } = await $.process.run(['ps', '-o', 'pid=', '-p', entries.map(entry => entry.pid).join(',')])
  const alive = new Set(stdout.split('\n').map(line => line.trim()).filter(line => line !== ''))
  for (const entry of entries) {
    if (!alive.has(String(entry.pid))) continue
    const file = `${ctx.root}/by-session/${entry.sessionId}`
    if (!(await $.fs.exists(file))) continue
    const account = (await $.fs.read(file)).trim()
    counts.set(account, (counts.get(account) ?? 0) + 1)
  }
  return counts
}

async function signedIn($: EngineInterface, ctx: Context): Promise<Account[]> {
  const found = await Promise.all(ctx.accounts.map(async account => ({ account, email: await emailOf($, account, ctx.home) })))
  return found.filter(row => row.email !== undefined).map(row => row.account)
}

export async function candidates($: EngineInterface, ctx: Context): Promise<Candidate[]> {
  const sessions = await liveSessions($, ctx)
  return Promise.all(
    (await signedIn($, ctx)).map(async account => ({
      name: account.name,
      reading: await readReading($, ctx.root, account.name),
      sessions: sessions.get(account.name) ?? 0,
    })),
  )
}

// After each measurement: save the reading for every session to see, and
// keep the status line's figure current.
export async function noteMeasure($: EngineInterface, state: SwitchState): Promise<void> {
  const ctx = await context($)
  if (ctx?.current === undefined) return
  const reading = await ownReading($, ctx.current.name)
  if (reading === undefined) return
  await writeReading($, ctx.root, reading)
  if (state.pending === undefined && !state.ending) {
    const use = describeUse(reading, await $.clock.now())
    $.ui.status(use === '' ? `account ${ctx.current.name}` : `account ${ctx.current.name} · ${use}`)
  }
}

// At a main-loop turn's end: move off an account that is nearly spent.
// `stopped`: whether the turn ended on an API error. Only a session that
// reopens moves: a VS Code panel (at once under cca-stream; one started
// before cca-stream at its next message, which then goes to the new
// account), or a terminal session a person is at. A `-p` run would come back
// as an interactive one, and a process cca did not start never reopens.
export async function balance($: EngineInterface, state: SwitchState, stopped: boolean): Promise<void> {
  if (state.pending !== undefined || state.ending) return
  if ((await $.env.get('CCA_BALANCE')) === 'off') return
  const ctx = await context($)
  if (ctx?.current === undefined) return
  const from = ctx.current.name
  const now = await $.clock.now()
  const reading = await ownReading($, from)
  const full = fullWindow(reading, now)
  if (reading === undefined || full === undefined) return
  const exit = await exitOf($, await $.session.id())
  if (exit === undefined || (exit.kind === 'terminal' && !state.interactive)) return
  const target = chooseTarget(from, await candidates($, ctx), now)
  if (target === undefined) {
    $.ui.log(`cc-accounts: ${from} is at ${describeUse(reading, now)}, and no other account has room to move to.`)
    return
  }
  const limit = stopped ? windowAtLimit(reading, now) : undefined
  const lost = limit === undefined ? [] : (await waitingFor($, state)).tasks
  const followUp = limit === undefined ? undefined : followUpText(from, target, limit, lost.map(nameTask))
  const asked = await requestSwitch($, state, ctx, exit, { target, force: limit !== undefined, followUp })
  const waits = asked.kind === 'queued'
  if (waits) $.ui.status(`account ${from}, moving to ${target}`)
  $.ui.log(
    `cc-accounts: ${from}'s ${windowName(limit ?? full)} window is at ${describeUse(reading, now)}; ` +
      `moving this conversation to ${target}${waits ? ' once its background work ends' : ''}.`,
  )
}
