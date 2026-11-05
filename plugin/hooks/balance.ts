// Keeping sessions off accounts that are nearly spent. Each session writes
// its account's rate-limit readings to usage/<account>.json; at the end of
// each main-loop turn, a session whose account has a window at its leave
// threshold moves to the account with the most room (usage.ts decides which).
// A turn the account itself stopped (a window at its limit, or an API error
// of the account's: a per-model limit, a lost login) moves at once and
// reopens with a follow-up message, so the work carries on with nobody
// typing; otherwise the move waits for the session's background work, as
// /account does. CCA_BALANCE=off stops the moves; readings are still written.
import type { EngineInterface } from 'claude-code'
import type { Account } from './accounts'
import { context, emailOf, exitOf, writeAtomic, type Context } from './context'
import { liveCrons } from './crons'
import { block, blockedAt, scopeOf, sessionFamily, turnFailure } from './failures'
import { requestSwitch, type SwitchState } from './switching'
import {
  ACCOUNT_FAILURES,
  chooseTarget,
  describeUse,
  formatReading,
  fullWindow,
  parseReading,
  POLICY,
  readingOf,
  resetsSoon,
  windowAtLimit,
  windowName,
  type Candidate,
  type Reading,
  type Stop,
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

// Every session on the account rewrites this file while others read it.
export async function writeReading($: EngineInterface, root: string, reading: Reading): Promise<void> {
  await writeAtomic($, usageFile(root, reading.account), formatReading(reading))
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

// Every signed-in account, with what a session on the model `family` needs
// to know of it.
export async function candidates($: EngineInterface, ctx: Context, family: string | undefined): Promise<Candidate[]> {
  const sessions = await liveSessions($, ctx)
  return Promise.all(
    (await signedIn($, ctx)).map(async account => ({
      name: account.name,
      reading: await readReading($, ctx.root, account.name),
      sessions: sessions.get(account.name) ?? 0,
      blockedAt: await blockedAt($, ctx.root, account.name, family),
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

// Why a stopped turn's account cannot go on: an API error of the account's
// that the readings do not explain (a usage limit with no window at it, or
// any other account failure), else a window at its limit.
export function stopOf(failure: string | undefined, window: string | undefined): Stop | undefined {
  const refused = failure !== undefined && ACCOUNT_FAILURES.has(failure)
  if (refused && (failure !== 'rate_limit' || window === undefined)) return { error: failure }
  return window === undefined ? undefined : { window }
}

// At a main-loop turn's end: move off an account that is nearly spent, or
// that stopped the turn. `stopped`: whether the turn ended on an API error.
// Only a session that reopens moves: a VS Code panel (at once under
// cca-stream; one started before cca-stream at its next message, which then
// goes to the new account), or a terminal session a person is at. A `-p` run
// would come back as an interactive one, and a process cca did not start
// never reopens.
export async function balance($: EngineInterface, state: SwitchState, stopped: boolean): Promise<void> {
  if (state.pending !== undefined || state.ending) return
  if ((await $.env.get('CCA_BALANCE')) === 'off') return
  const ctx = await context($)
  if (ctx?.current === undefined) return
  const from = ctx.current.name
  const now = await $.clock.now()
  const reading = await ownReading($, from)
  const full = fullWindow(reading, now)
  const stop = stopped ? stopOf(await turnFailure($, ctx), windowAtLimit(reading, now)) : undefined
  if (stop === undefined && full === undefined) return
  const family = await sessionFamily($, state.answered)
  // A failure the readings do not explain is recorded, so that no session
  // that would meet it moves here for a while. One they explain needs no
  // record: they show it to every session, and when it resets.
  if (stop !== undefined && 'error' in stop) await block($, ctx.root, from, scopeOf(stop.error, family), stop.error, now)
  const exit = await exitOf($, await $.session.id())
  if (exit === undefined || (exit.kind === 'terminal' && !state.interactive)) return
  if (stop === undefined && full !== undefined) {
    // A session the extension started before cca-stream cannot be told to
    // set its wakeups again, so it keeps them, or wakeups it cannot rule out,
    // until its account stops a turn.
    if (exit.switchFile === undefined && (await liveCrons($))?.length !== 0) return
    if (resetsSoon(reading, full, now)) {
      $.ui.log(`cc-accounts: ${from}'s ${windowName(full)} window is at ${describeUse(reading, now)} but resets within ${POLICY.resetGraceMs / 60_000} minutes; staying.`)
      return
    }
  }
  const target = chooseTarget(from, await candidates($, ctx, family), now, stop === undefined ? POLICY.take : POLICY.leave)
  // `full` is set whenever `stop` is not.
  const why = stop !== undefined && 'error' in stop
    ? `${from} failed the last turn (${stop.error})`
    : `${from}'s ${windowName(stop !== undefined && 'window' in stop ? stop.window : full ?? 'five_hour')} window is at ${describeUse(reading, now)}`
  if (target === undefined) {
    $.ui.log(`cc-accounts: ${why}, and no other account has room to move to.`)
    return
  }
  const asked = await requestSwitch($, state, ctx, exit, { target, force: stop !== undefined, stop })
  const waits = asked.kind === 'queued'
  if (waits) $.ui.status(`account ${from}, moving to ${target}`)
  $.ui.log(`cc-accounts: ${why}; moving this conversation to ${target}${waits ? ' once its background work ends' : ''}.`)
}
