// How full each account's rate-limit windows are, and which account a
// session should move to when its own is nearly spent. Pure: balance.ts does
// the reading and writing.
//
// Every session writes the readings its responses carry (the five-hour and
// weekly windows, as the status line has them) to usage/<account>.json, so
// each session also knows the accounts it is not on. An account with no
// session yet has no reading, and counts as unused until one reports.

export type Window = { percentUsed: number; resetsAt?: string }

export type Reading = { account: string; at: number; windows: Record<string, Window> }

// One account a session could move to: its last reading, the summed weights
// of the live sessions already on it (`load`: each counts by its project's
// priority, 1 unless set), how big its plan is in Max 5x plans (`units`),
// and, after an API call on it failed for a reason of the account's, until
// when sessions keep off it (`blockedUntil`).
export type Candidate = {
  name: string
  reading: Reading | undefined
  load: number
  units: number
  blockedUntil?: number
}

const HOUR_MS = 3_600_000

// The thresholds, in percent of a window. A session leaves its account at the
// end of a turn once a window reaches `leave`. Once one reaches `yieldAt`, a
// session leaves to make room for a heavier one (a project of higher
// priority) on the same account. A planned move goes only to an account whose
// windows are all below `take`, preferring the one whose week resets first,
// then among weeks resetting together the one with the most room after
// counting `perSession` points for each unit of load already on it, divided
// by its plan size, so that sessions leaving one account together spread out
// and keep off the accounts where heavier ones run. A session
// whose turn was already stopped takes any account below `leave`: any room
// beats none. A turn that ended on an API error with a window at `limit` or
// more was stopped by the limit. An account whose API call failed for a
// reason of its own is skipped for a while (`blockMsOf`). A planned move is not made when
// the full window resets within `resetGraceMs`: a move costs the new account
// the whole context uncached, and a limit hit before the reset still moves.
// Room an account's week has left is lost when the week resets, so among the
// accounts with room the one whose week resets first is spent first, and a
// session moves to it from an account whose week resets at least `soonerMs`
// later (`soonerTarget`); the margin keeps sessions from moving for an
// hour's difference.
export const POLICY = {
  leave: { five_hour: 90, seven_day: 99 } as Record<string, number>,
  yieldAt: { five_hour: 75, seven_day: 95 } as Record<string, number>,
  take: { five_hour: 70, seven_day: 97 } as Record<string, number>,
  perSession: 10,
  limit: 99,
  limitBlockMs: HOUR_MS,
  refusalBlockMs: 24 * HOUR_MS,
  resetGraceMs: 15 * 60_000,
  soonerMs: 6 * HOUR_MS,
}

// How long a failure keeps sessions off an account. A usage limit may clear
// at any time, so the account is tried again after an hour. A refusal does
// not clear on its own (a lost login, an organization that turned Claude
// Code off, a hold, a billing failure), so it is tried again after a day.
export function blockMsOf(error: string): number {
  return error === 'rate_limit' ? POLICY.limitBlockMs : POLICY.refusalBlockMs
}

// API errors that are the account's, as Claude Code classifies them (the
// word StopFailure carries): another account does not share them.
// `rate_limit` covers every limit, the per-model ones the readings do not show.
export const ACCOUNT_FAILURES: ReadonlySet<string> = new Set([
  'rate_limit',
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
])

// What stopped the last turn, when a move must not wait: a window at its
// limit by the readings, or the API's classification of an account failure.
export type Stop = { window: string } | { error: string }
// How long each window runs: a reading without a reset time stops counting
// once a whole window has passed since it was taken.
const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR_MS, seven_day: 7 * 24 * HOUR_MS }

const NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly' }

export function windowName(kind: string): string {
  return NAMES[kind] ?? kind
}

export function readingOf(
  account: string,
  at: number,
  limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
): Reading {
  const windows: Record<string, Window> = {}
  for (const limit of limits) {
    windows[limit.kind] = limit.resetsAt === undefined
      ? { percentUsed: limit.percentUsed }
      : { percentUsed: limit.percentUsed, resetsAt: limit.resetsAt }
  }
  return { account, at, windows }
}

export function formatReading(reading: Reading): string {
  return `${JSON.stringify(reading)}\n`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// undefined: not a reading (a partial write, another version's file).
export function parseReading(text: string): Reading | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // A file caught mid-write: the caller treats the account as unread.
    return undefined
  }
  if (!isObject(value) || typeof value.account !== 'string' || typeof value.at !== 'number') return undefined
  if (!isObject(value.windows)) return undefined
  const windows: Record<string, Window> = {}
  for (const [kind, window] of Object.entries(value.windows)) {
    if (!isObject(window) || typeof window.percentUsed !== 'number') return undefined
    windows[kind] = typeof window.resetsAt === 'string'
      ? { percentUsed: window.percentUsed, resetsAt: window.resetsAt }
      : { percentUsed: window.percentUsed }
  }
  return { account: value.account, at: value.at, windows }
}

// A window's use at `now`: 0 once it has reset since the reading.
export function percentNow(reading: Reading | undefined, kind: string, now: number): number {
  const window = reading?.windows[kind]
  if (reading === undefined || window === undefined) return 0
  if (window.resetsAt !== undefined) {
    const resets = Date.parse(window.resetsAt)
    if (!Number.isNaN(resets)) return resets <= now ? 0 : window.percentUsed
  }
  const length = WINDOW_MS[kind]
  return length !== undefined && now - reading.at >= length ? 0 : window.percentUsed
}

// The window that makes a session leave its account, or undefined.
export function fullWindow(reading: Reading | undefined, now: number): string | undefined {
  return Object.keys(POLICY.leave).find(kind => percentNow(reading, kind, now) >= POLICY.leave[kind]!)
}

// Whether `kind` resets within the grace period, so a planned move off it
// would cost more than it saves.
export function resetsSoon(reading: Reading | undefined, kind: string, now: number): boolean {
  const resetsAt = reading?.windows[kind]?.resetsAt
  if (resetsAt === undefined) return false
  const resets = Date.parse(resetsAt)
  return !Number.isNaN(resets) && resets > now && resets - now <= POLICY.resetGraceMs
}

// The window past which a lighter session makes room for a heavier one, or undefined.
export function tightWindow(reading: Reading | undefined, now: number): string | undefined {
  return Object.keys(POLICY.yieldAt).find(kind => percentNow(reading, kind, now) >= POLICY.yieldAt[kind]!)
}

// The window at its limit, or undefined.
export function windowAtLimit(reading: Reading | undefined, now: number): string | undefined {
  return Object.keys(POLICY.leave).find(kind => percentNow(reading, kind, now) >= POLICY.limit)
}

// What an account nobody has measured yet is assumed to be using: just under
// the take line, so a measured account with room wins and the unmeasured one
// is only a last resort. A reading whose window has reset is known empty.
const UNMEASURED_PERCENT = POLICY.take.five_hour! - 1

// Whether `candidate` can take a session now: not held off after a failure,
// and every window below `bar`.
function fits(candidate: Candidate, now: number, bar: Readonly<Record<string, number>>): boolean {
  if (candidate.blockedUntil !== undefined && now < candidate.blockedUntil) return false
  return Object.keys(bar).every(kind => percentNow(candidate.reading, kind, now) < bar[kind]!)
}

// When the account's week resets, the moment its room is lost; Infinity when
// no reading says (an account nobody has measured, a week already reset).
export function weekEnds(reading: Reading | undefined, now: number): number {
  const resetsAt = reading?.windows.seven_day?.resetsAt
  if (resetsAt === undefined) return Infinity
  const resets = Date.parse(resetsAt)
  return Number.isNaN(resets) || resets <= now ? Infinity : resets
}

// The account to move to, or undefined when none has room below `bar`
// (POLICY.take for a planned move, POLICY.leave for a stopped turn's): the
// one whose week resets first, its room being lost first; among accounts
// whose weeks reset together, `preferred` if it is one of them, else the one
// with the most five-hour room after counting the load already on it.
export function chooseTarget(
  current: string,
  candidates: readonly Candidate[],
  now: number,
  bar: Readonly<Record<string, number>>,
  preferred?: string,
): string | undefined {
  let best: { name: string; ends: number; first: boolean; score: number } | undefined
  for (const candidate of candidates) {
    if (candidate.name === current || !fits(candidate, now, bar)) continue
    const used = candidate.reading === undefined ? UNMEASURED_PERCENT : percentNow(candidate.reading, 'five_hour', now)
    const option = {
      name: candidate.name,
      ends: weekEnds(candidate.reading, now),
      first: candidate.name === preferred,
      score: used + (POLICY.perSession * candidate.load) / candidate.units,
    }
    if (best === undefined || option.ends < best.ends ||
      (option.ends === best.ends && (option.first > best.first || (option.first === best.first && option.score < best.score)))) {
      best = option
    }
  }
  return best?.name
}

// The account a new session should start on, a new session being a planned
// arrival: the one a planned move would take, the default (`preferred`)
// winning among accounts whose weeks reset together; else the one a stopped
// turn would; else the default, when no account has room.
export function startAccount(preferred: string | undefined, candidates: readonly Candidate[], now: number): string | undefined {
  return chooseTarget('', candidates, now, POLICY.take, preferred) ?? chooseTarget('', candidates, now, POLICY.leave, preferred) ?? preferred
}

// An account with room whose week resets at least POLICY.soonerMs before
// the one the session is on, which it should move to so that room is spent
// before it is lost; undefined when there is none.
export function soonerTarget(current: Candidate, candidates: readonly Candidate[], now: number): string | undefined {
  const target = chooseTarget(current.name, candidates, now, POLICY.take)
  const found = candidates.find(candidate => candidate.name === target)
  if (found === undefined) return undefined
  const ends = weekEnds(found.reading, now)
  // A week with no known reset loses nothing that moving would save.
  return Number.isFinite(ends) && ends + POLICY.soonerMs <= weekEnds(current.reading, now) ? target : undefined
}

// The windows in words, to follow an account's name and `'s` in a log line:
// `5-hour window is at 46% and its weekly window at 95%`.
export function describeWindows(reading: Reading | undefined, now: number): string {
  const parts = ['five_hour', 'seven_day']
    .filter(kind => reading?.windows[kind] !== undefined)
    .map((kind, index) => {
      const figure = `${Math.round(percentNow(reading, kind, now))}%`
      return index === 0 ? `${windowName(kind)} window is at ${figure}` : `its ${windowName(kind)} window at ${figure}`
    })
  return parts.length === 0 ? 'usage is not known yet' : parts.join(' and ')
}

// `5h 42%`, for the status line and /account; '' with no reading.
export function describeUse(reading: Reading | undefined, now: number): string {
  if (reading === undefined || reading.windows.five_hour === undefined) return ''
  const week = reading.windows.seven_day === undefined ? '' : `, week ${Math.round(percentNow(reading, 'seven_day', now))}%`
  return `5h ${Math.round(percentNow(reading, 'five_hour', now))}%${week}`
}

// What the conversation is told when it reopens on `to`, or undefined when
// it needs to be told nothing: `stop`, what stopped its last turn;
// `interrupted`, whether ending the process cut short a turn a message
// started after the switch was decided; `stopped`, the background work the
// move ended. Scheduled wakeups need no word: Claude Code restores the
// session's own when the conversation is resumed.
export type Move = {
  from: string | undefined
  to: string
  stop: Stop | undefined
  interrupted: boolean
  stopped: readonly string[]
}

// How the conversation is told what stopped its last turn.
function describeStop(from: string | undefined, stop: Stop): string {
  if ('window' in stop) return `The ${from} account reached its ${windowName(stop.window)} usage limit and stopped your last turn.`
  if (stop.error === 'rate_limit') return `The ${from} account reached a usage limit and stopped your last turn.`
  return `The ${from} account could not serve your last turn (${stop.error}).`
}

export function followUpText(move: Move): string | undefined {
  const parts: string[] = []
  if (move.stop !== undefined) {
    parts.push(
      `${describeStop(move.from, move.stop)} ` +
        `This conversation now runs on the ${move.to} account. Carry on from where you stopped.`,
    )
    if (move.stopped.length > 0) {
      parts.push(`The move stopped this background work, so start again whatever of it is still needed: ${move.stopped.join(', ')}.`)
    }
  } else if (move.interrupted) {
    parts.push(`Moving this conversation to the ${move.to} account interrupted your turn. Carry on from where you stopped.`)
  }
  return parts.length === 0 ? undefined : `[cc-accounts] ${parts.join(' ')}`
}
