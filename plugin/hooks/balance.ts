// Keeping sessions off accounts that are nearly spent. Each session writes
// its account's rate-limit readings to usage/<account>.json; at the end of
// each main-loop turn, a session whose account has a window at its leave
// threshold moves to the account with room whose week resets first, and one
// whose week resets well after another's with room moves there (usage.ts
// decides which).
// A turn the account itself stopped (a window at its limit, or an API error
// of the account's: a per-model limit, a lost login) moves at once and
// reopens with a follow-up message, so the work carries on with nobody
// typing; otherwise the move waits for the session's background work, as
// /account does. Projects can matter more than others (priorities.ts): a
// session counts by its project's weight, and on an account running low a
// lighter session moves off to leave the rest to a heavier one.
// CCA_BALANCE=off stops the moves; readings are still written.
import type { EngineInterface } from 'claude-code'
import { context, defaultName, describeError, exitOf, inDesktopApp, startFile, writeAtomic, type Context } from './context'
import { block, blockedUntil, scopeOf, sessionFamily, turnFailure } from './failures'
import { heavierOn, loads, projectName, readPriorities, weightOf, type Priorities } from './priorities'
import { accountStates, liveSessions, ownContext, ownReading, writeReading, type LiveSession } from './survey'
import { dropSwitch, requestSwitch, type Exit, type SwitchState } from './switching'
import {
  ACCOUNT_FAILURES,
  accountStatus,
  chooseTarget,
  describeWindows,
  fullWindow,
  percentNow,
  POLICY,
  waitsForReset,
  soonerTarget,
  spreadTarget,
  startAccount,
  tightWindow,
  weekEnds,
  windowAtLimit,
  windowName,
  type Candidate,
  type Reading,
  type Stop,
} from './usage'

// Every signed-in account, with what a session on the model `family` needs
// to know of it: its reading, its load, its plan size and any failure that
// keeps such a session off it.
export async function candidates(
  $: EngineInterface,
  ctx: Context,
  family: string | undefined,
  live: readonly LiveSession[],
  priorities: Priorities,
): Promise<Candidate[]> {
  const load = loads(live, priorities)
  const states = (await accountStates($, ctx)).filter(state => state.email !== undefined)
  return Promise.all(
    states.map(async state => ({
      name: state.account.name,
      reading: state.reading,
      load: load.get(state.account.name) ?? 0,
      units: state.units,
      blockedUntil: await blockedUntil($, ctx.root, state.account.name, family, state.reading?.at),
    })),
  )
}

// Where a new session should start, from every account's readings (this
// session's own, fresher than its file, for its account): the default while
// it has room, else the account a move would take. Published for cca, which
// reads it when it starts a new conversation, at every turn's end and by
// /account, so it follows the readings. With the balancer off nothing is
// published, and cca keeps to the default.
export async function publishStart($: EngineInterface, ctx: Context): Promise<string | undefined> {
  const preferred = await defaultName($, ctx)
  if ((await $.env.get('CCA_BALANCE')) === 'off') return preferred
  const live = await liveSessions($, ctx)
  const options = await candidates($, ctx, undefined, live, await readPriorities($, ctx.root))
  const own = ctx.current === undefined ? undefined : await ownReading($, ctx.current.name)
  const current = options.map(option => (own !== undefined && option.name === own.account ? { ...option, reading: own } : option))
  const chosen = startAccount(preferred, current, await $.clock.now())
  if (chosen !== undefined) await writeAtomic($, startFile(ctx.root), `${chosen}\n`)
  return chosen
}

// Where new sessions start, published for cca as it is shown; the default
// when that cannot be worked out (reported).
export async function startOrDefault($: EngineInterface, ctx: Context, preferred: string | undefined): Promise<string | undefined> {
  try {
    return await publishStart($, ctx)
  } catch (error) {
    $.ui.log(`cc-accounts: could not work out where new sessions start (${describeError(error)}).`)
    return preferred
  }
}

// After each measurement: save the reading for every session to see, and
// keep the status line's figure current.
export async function noteMeasure($: EngineInterface, state: SwitchState): Promise<void> {
  const ctx = await context($)
  if (ctx?.current === undefined) return
  const reading = await ownReading($, ctx.current.name)
  if (reading === undefined) return
  await writeReading($, ctx.root, reading)
  await showStatus($, state)
}

// The status line as things stand: the account, its use and the context
// window's fill. A switch under way keeps the line that names it.
export async function showStatus($: EngineInterface, state: SwitchState): Promise<void> {
  const ctx = await context($)
  if (ctx?.current === undefined || state.pending !== undefined || state.ending) return
  const reading = await ownReading($, ctx.current.name)
  $.ui.status(accountStatus(ctx.current.name, reading, await $.clock.now(), state.strandedNote, await ownContext($)))
}

// Why a stopped turn's account cannot go on: an API error of the account's
// that the readings do not explain (a usage limit with no window at it, or
// any other account failure), else a window at its limit.
export function stopOf(failure: string | undefined, window: string | undefined): Stop | undefined {
  const refused = failure !== undefined && ACCOUNT_FAILURES.has(failure)
  if (refused && (failure !== 'rate_limit' || window === undefined)) return { error: failure }
  return window === undefined ? undefined : { window }
}

// At a main-loop turn's end: move off an account that is nearly spent, that
// stopped the turn, or that runs low while a heavier session shares it.
// `stopped`: whether the turn ended on an API error. Only a session that
// reopens moves: a VS Code panel (at once under cca-stream; one started
// before cca-stream at its next message, which then goes to the new
// account), or a terminal session a person is at. A `-p` run would come back
// as an interactive one, and a process cca did not start never reopens.
// A move the balancer queued behind background work is decided again at each
// turn's end, since the readings that called for it change while it waits
// (2026-11-17: one queued to spend a week before its reset waited past the
// reset): it keeps waiting while the same move is called for, goes to
// another account that now fits better, or is dropped. A person's /account
// switch is theirs and is left alone.
export async function balance($: EngineInterface, state: SwitchState, stopped: boolean): Promise<void> {
  if (state.ending) return
  const pending = state.pending
  if (pending !== undefined && (stopped || pending.by === 'person' || pending.force)) return stopped ? hurry($, state) : undefined
  if ((await $.env.get('CCA_BALANCE')) === 'off') return
  const ctx = await context($)
  if (ctx?.current === undefined) return
  const plan = await planMove($, state, ctx, ctx.current.name, stopped)
  if (plan !== undefined && plan.target === pending?.target) return
  if (plan !== undefined) return move($, state, ctx, plan)
  if (pending === undefined) return
  await dropSwitch($, state, ctx)
  $.ui.log(`cc-accounts: nothing calls for the move to ${pending.target} any more; this conversation stays on ${ctx.current.name}.`)
}

// A move the balancer would make now: where to, how the process ends for
// it, whether it goes at once (a turn the account stopped), and why.
type Plan = { from: string; target: string; exit: Exit; force: boolean; stop: Stop | undefined; why: string }

async function move($: EngineInterface, state: SwitchState, ctx: Context, plan: Plan): Promise<void> {
  const { from, target, exit, force, stop, why } = plan
  const asked = await requestSwitch($, state, ctx, exit, { target, force, stop, by: 'balancer' })
  const waits = asked.kind === 'queued'
  if (waits) $.ui.status(`account ${from}, moving to ${target}`)
  $.ui.log(`cc-accounts: ${why}; moving this conversation to ${target}${waits ? ' once its background work ends' : ''}.`)
}

// The live sessions, with this one on the account it runs on: a queued move
// has already recorded it on its target, where it does not run yet.
async function liveHere($: EngineInterface, ctx: Context, from: string): Promise<LiveSession[]> {
  const self = await $.session.id()
  return (await liveSessions($, ctx)).map(live => (live.sessionId === self ? { ...live, account: from } : live))
}

async function planMove($: EngineInterface, state: SwitchState, ctx: Context, from: string, stopped: boolean): Promise<Plan | undefined> {
  const now = await $.clock.now()
  const reading = await ownReading($, from)
  const stop = stopped ? stopOf(await turnFailure($, ctx), windowAtLimit(reading, now)) : undefined
  const full = fullWindow(reading, now)
  const tight = tightWindow(reading, now)
  // Room again: what a session that cannot move told of is over.
  if (stop === undefined && full === undefined) {
    state.stranded = undefined
    state.strandedNote = undefined
  }
  const exit = await exitOf($, await $.session.id())
  if (exit === undefined) {
    await stranded($, state, ctx, from, reading, stop, full, now)
    return undefined
  }
  if (exit.kind === 'terminal' && !state.interactive) return undefined
  const live = await liveHere($, ctx, from)
  const priorities = await readPriorities($, ctx.root)
  const mine = weightOf(priorities, await $.session.root())
  // Below the leave line, only a session with a heavier one beside it moves.
  const heavier = stop === undefined && full === undefined && tight !== undefined
    ? heavierOn(live, priorities, from, await $.session.id(), mine.weight)
    : undefined
  if (stop === undefined && full === undefined && heavier === undefined) {
    return soonerPlan($, state, ctx, { from, reading, now, exit, live, priorities, arriving: mine.weight })
  }
  // `full ?? tight` is set whenever `stop` is not.
  const window = stop !== undefined && 'window' in stop ? stop.window : full ?? tight ?? 'five_hour'
  if (stop === undefined && waitsForReset(reading, tight, now)) {
    $.ui.log(
      `cc-accounts: ${from}'s ${describeWindows(reading, now)}, but the ${windowName(window)} window resets within ` +
        `${POLICY.resetGraceMs / 60_000} minutes; staying.`,
    )
    return undefined
  }
  const family = await sessionFamily($, state.answered)
  // A failure the readings do not explain is recorded, so that no session
  // that would meet it moves here for a while. One they explain needs no
  // record: they show it to every session, and when it resets.
  if (stop !== undefined && 'error' in stop) await block($, ctx.root, from, scopeOf(stop.error, family), stop.error, now)
  const options = await candidates($, ctx, family, live, priorities)
  const target = chooseTarget(from, options, now, stop === undefined ? POLICY.take : POLICY.leave, undefined, mine.weight)
  const why = stop !== undefined && 'error' in stop
    ? `${from} failed the last turn (${stop.error})`
    : heavier !== undefined
      ? `${from}'s ${describeWindows(reading, now)}, and ${projectName(heavier.folder)} (priority ${heavier.weight}) on it outweighs ` +
        `this project (priority ${mine.weight})`
      : `${from}'s ${describeWindows(reading, now)}`
  if (target === undefined) {
    // Making room is a courtesy: with nowhere better to go, the session stays quietly.
    if (heavier === undefined) $.ui.log(`cc-accounts: ${why}, and no other account has room to move to.`)
    return undefined
  }
  return { from, target, exit, force: stop !== undefined, stop, why }
}

// A session that would leave its account but that nothing would reopen
// elsewhere: one the Claude desktop app started, which runs it on the account
// the app is signed in to, or one cca did not start. It stays, and says so
// once per full window, with the account to go on on and how. It records no
// failure: the login that failed may be the host's, not the account's in cca.
// Making room for a heavier session is a courtesy, so a tight window alone
// says nothing.
async function stranded(
  $: EngineInterface,
  state: SwitchState,
  ctx: Context,
  from: string,
  reading: Reading | undefined,
  stop: Stop | undefined,
  full: string | undefined,
  now: number,
): Promise<void> {
  if (stop === undefined && full === undefined) return
  const window = stop !== undefined && 'window' in stop ? stop.window : full ?? 'five_hour'
  if (stop === undefined && waitsForReset(reading, undefined, now)) return
  const failed = stop !== undefined && 'error' in stop ? stop.error : undefined
  const told = failed !== undefined ? `${from} ${failed}` : `${from} ${window} ${reading?.windows[window]?.resetsAt ?? ''}`
  if (state.stranded === told) return
  state.stranded = told
  const priorities = await readPriorities($, ctx.root)
  const options = await candidates($, ctx, await sessionFamily($, state.answered), await liveSessions($, ctx), priorities)
  const arriving = weightOf(priorities, await $.session.root()).weight
  const target = chooseTarget(from, options, now, stop === undefined ? POLICY.take : POLICY.leave, undefined, arriving)
  const desktop = await inDesktopApp($)
  const why = failed !== undefined ? `${from} failed the last turn (${failed})` : `${from}'s ${describeWindows(reading, now)}`
  const cause = desktop
    ? 'the Claude desktop app runs it on the account the app is signed in to'
    : 'cca did not start it, so nothing would reopen it on another account'
  const command = `\`cca ${target} --resume ${await $.session.id()}\``
  const next = target === undefined
    ? 'No other account has room either.'
    : desktop
      ? `${target} has room: close this conversation here, then reopen it in VS Code and type /account ${target}, or run ${command} in a terminal.`
      : `${target} has room: go on with this conversation in a terminal with ${command}.`
  $.ui.log(`cc-accounts: ${why}, and this session cannot move: ${cause}. ${next}`)
  state.strandedNote = ` · cannot move${target === undefined ? '' : `; ${target} has room`}`
  $.ui.status(accountStatus(from, reading, now, state.strandedNote, await ownContext($)))
}

// A turn the account stopped while a move waits for the session's background
// work: nothing can go on here, and the work may run for hours (2026-11-10: a
// session holding gate waits stayed on a spent week through every message),
// so the move goes now and stops the work, as a move the stop decided would.
// The target stands: the person or the balancer chose it, and the
// conversation is already recorded there. The move is not new, so it goes
// with the balancer off too.
async function hurry($: EngineInterface, state: SwitchState): Promise<void> {
  const pending = state.pending
  if (pending === undefined || pending.force) return
  const ctx = await context($)
  if (ctx?.current === undefined) return
  const from = ctx.current.name
  const now = await $.clock.now()
  const stop = stopOf(await turnFailure($, ctx), windowAtLimit(await ownReading($, from), now))
  if (stop === undefined) return
  if ('error' in stop) await block($, ctx.root, from, scopeOf(stop.error, await sessionFamily($, state.answered)), stop.error, now)
  state.pending = { ...pending, force: true, stop }
  $.ui.log(`cc-accounts: ${from} stopped the last turn; moving this conversation to ${pending.target} now, stopping its background work.`)
}

// With nothing pressing on its account: move to an account whose week resets
// well before this one's and has room, so that room is spent before the reset
// takes it (usage.ts, soonerTarget). The move is planned, so it waits for the
// session's background work and goes only where a planned move may.
// `arriving`: this session's project weight.
async function soonerPlan(
  $: EngineInterface,
  state: SwitchState,
  ctx: Context,
  here: {
    from: string
    reading: Reading | undefined
    now: number
    exit: Exit
    live: readonly LiveSession[]
    priorities: Priorities
    arriving: number
  },
): Promise<Plan | undefined> {
  const { from, reading, now, exit, live, priorities, arriving } = here
  const options = await candidates($, ctx, await sessionFamily($, state.answered), live, priorities)
  // This session's own reading is fresher than its account's file; before
  // its first response it has none, and its account's saved one stands in.
  const own = options.find(option => option.name === from)
  const current = { name: from, reading: reading ?? own?.reading, load: own?.load ?? 0, units: own?.units ?? 1 }
  const sooner = soonerTarget(current, options, now, arriving)
  const target = sooner ?? spreadTarget(current, options, now, arriving)
  if (target === undefined) return undefined
  const why = sooner !== undefined
    ? `${target}'s week resets at ${utcMinute(weekEnds(options.find(option => option.name === target)?.reading, now))} UTC, ` +
      `well before ${from}'s, and has room it would lose`
    : `the sessions working on ${from} would fill its 5-hour window, which is at ` +
      `${percentNow(reading, 'five_hour', now)}%, and ${target} has room`
  return { from, target, exit, force: false, stop: undefined, why }
}

function utcMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}
