// Keeping sessions off accounts that are nearly spent. Each session writes
// its account's rate-limit readings to usage/<account>.json; at the end of
// each main-loop turn, a session whose account has a window at its leave
// threshold moves to the account with the most room (usage.ts decides which).
// A turn the account itself stopped (a window at its limit, or an API error
// of the account's: a per-model limit, a lost login) moves at once and
// reopens with a follow-up message, so the work carries on with nobody
// typing; otherwise the move waits for the session's background work, as
// /account does. Projects can matter more than others (priorities.ts): a
// session counts by its project's weight, and on an account running low a
// lighter session moves off to leave the rest to a heavier one.
// CCA_BALANCE=off stops the moves; readings are still written.
import type { EngineInterface } from 'claude-code'
import { context, exitOf, type Context } from './context'
import { liveCrons } from './crons'
import { block, blockedUntil, scopeOf, sessionFamily, turnFailure } from './failures'
import { heavierOn, loads, projectName, readPriorities, weightOf, type Priorities } from './priorities'
import { accountStates, liveSessions, ownReading, writeReading, type LiveSession } from './survey'
import { requestSwitch, type SwitchState } from './switching'
import {
  ACCOUNT_FAILURES,
  chooseTarget,
  describeUse,
  fullWindow,
  POLICY,
  resetsSoon,
  tightWindow,
  windowAtLimit,
  windowName,
  type Candidate,
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
      blockedUntil: await blockedUntil($, ctx.root, state.account.name, family),
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

// At a main-loop turn's end: move off an account that is nearly spent, that
// stopped the turn, or that runs low while a heavier session shares it.
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
  const stop = stopped ? stopOf(await turnFailure($, ctx), windowAtLimit(reading, now)) : undefined
  const full = fullWindow(reading, now)
  const tight = tightWindow(reading, now)
  if (stop === undefined && full === undefined && tight === undefined) return
  const exit = await exitOf($, await $.session.id())
  if (exit === undefined || (exit.kind === 'terminal' && !state.interactive)) return
  const live = await liveSessions($, ctx)
  const priorities = await readPriorities($, ctx.root)
  // Below the leave line, only a session with a heavier one beside it moves.
  const mine = weightOf(priorities, state.cwd ?? '')
  const heavier = stop === undefined && full === undefined
    ? heavierOn(live, priorities, from, await $.session.id(), mine.weight)
    : undefined
  if (stop === undefined && full === undefined && heavier === undefined) return
  // `full ?? tight` is set whenever `stop` is not.
  const window = stop !== undefined && 'window' in stop ? stop.window : full ?? tight ?? 'five_hour'
  if (stop === undefined) {
    // A session the extension started before cca-stream cannot be told to
    // set its wakeups again, so it keeps them, or wakeups it cannot rule out,
    // until its account stops a turn.
    if (exit.switchFile === undefined && (await liveCrons($))?.length !== 0) return
    if (resetsSoon(reading, window, now)) {
      $.ui.log(`cc-accounts: ${from}'s ${windowName(window)} window is at ${describeUse(reading, now)} but resets within ${POLICY.resetGraceMs / 60_000} minutes; staying.`)
      return
    }
  }
  const family = await sessionFamily($, state.answered)
  // A failure the readings do not explain is recorded, so that no session
  // that would meet it moves here for a while. One they explain needs no
  // record: they show it to every session, and when it resets.
  if (stop !== undefined && 'error' in stop) await block($, ctx.root, from, scopeOf(stop.error, family), stop.error, now)
  const options = await candidates($, ctx, family, live, priorities)
  const target = chooseTarget(from, options, now, stop === undefined ? POLICY.take : POLICY.leave)
  const why = stop !== undefined && 'error' in stop
    ? `${from} failed the last turn (${stop.error})`
    : heavier !== undefined
      ? `${from} is at ${describeUse(reading, now)}, and ${projectName(heavier.folder)} (priority ${heavier.weight}) on it outweighs ` +
        `this project (priority ${mine.weight})`
      : `${from}'s ${windowName(window)} window is at ${describeUse(reading, now)}`
  if (target === undefined) {
    // Making room is a courtesy: with nowhere better to go, the session stays quietly.
    if (heavier === undefined) $.ui.log(`cc-accounts: ${why}, and no other account has room to move to.`)
    return
  }
  const asked = await requestSwitch($, state, ctx, exit, { target, force: stop !== undefined, stop })
  const waits = asked.kind === 'queued'
  if (waits) $.ui.status(`account ${from}, moving to ${target}`)
  $.ui.log(`cc-accounts: ${why}; moving this conversation to ${target}${waits ? ' once its background work ends' : ''}.`)
}
