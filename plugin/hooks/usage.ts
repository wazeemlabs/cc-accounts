import type { Cron } from './background'

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

// One account a session could move to: its last reading and how many live
// sessions already run on it.
export type Candidate = { name: string; reading: Reading | undefined; sessions: number }

// The thresholds, in percent of a window. A session leaves its account at the
// end of a turn once a window reaches `leave`. It moves only to an account
// whose windows are all below `take`, preferring the one with the most room
// after counting `perSession` points for each live session already on it, so
// that sessions leaving one account together spread out. A turn that ended on
// an API error with a window at `limit` or more was stopped by the limit.
export const POLICY = {
  leave: { five_hour: 90, seven_day: 95 } as Record<string, number>,
  take: { five_hour: 70, seven_day: 90 } as Record<string, number>,
  perSession: 10,
  limit: 99,
}

const HOUR_MS = 3_600_000
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

// The window at its limit, or undefined.
export function windowAtLimit(reading: Reading | undefined, now: number): string | undefined {
  return Object.keys(POLICY.leave).find(kind => percentNow(reading, kind, now) >= POLICY.limit)
}

// The account to move to, or undefined when none has room.
export function chooseTarget(current: string, candidates: readonly Candidate[], now: number): string | undefined {
  let best: { name: string; score: number } | undefined
  for (const candidate of candidates) {
    if (candidate.name === current) continue
    const roomy = Object.keys(POLICY.take).every(kind => percentNow(candidate.reading, kind, now) < POLICY.take[kind]!)
    if (!roomy) continue
    const score = percentNow(candidate.reading, 'five_hour', now) + POLICY.perSession * candidate.sessions
    if (best === undefined || score < best.score) best = { name: candidate.name, score }
  }
  return best?.name
}

// `5h 42%`, for the status line and /account; '' with no reading.
export function describeUse(reading: Reading | undefined, now: number): string {
  if (reading === undefined || reading.windows.five_hour === undefined) return ''
  const week = reading.windows.seven_day === undefined ? '' : `, week ${Math.round(percentNow(reading, 'seven_day', now))}%`
  return `5h ${Math.round(percentNow(reading, 'five_hour', now))}%${week}`
}

// A wakeup as the conversation can set it again.
function describeCron(cron: Cron): string {
  return `${cron.recurring ? 'recurring' : 'once'} at "${cron.schedule}" with the prompt ${JSON.stringify(cron.prompt)}`
}

// What the conversation is told when it reopens on `to`, or undefined when
// it needs to be told nothing: `limit`, the window whose limit stopped its
// last turn; `stopped`, the background work the move ended; `crons`, the
// scheduled wakeups the move dropped.
export function followUpText(move: {
  from: string | undefined
  to: string
  limit: string | undefined
  stopped: readonly string[]
  crons: readonly Cron[]
}): string | undefined {
  const parts: string[] = []
  if (move.limit !== undefined) {
    parts.push(
      `The ${move.from} account reached its ${windowName(move.limit)} usage limit and stopped your last turn. ` +
        `This conversation now runs on the ${move.to} account. Carry on from where you stopped.`,
    )
    if (move.stopped.length > 0) {
      parts.push(`The move stopped this background work, so start again whatever of it is still needed: ${move.stopped.join(', ')}.`)
    }
  }
  if (move.crons.length > 0) {
    if (move.limit === undefined) parts.push(`This conversation moved to the ${move.to} account.`)
    parts.push(
      `The move dropped your scheduled wakeups. Schedule them again: ${move.crons.map(describeCron).join('; ')}.` +
        (move.limit === undefined ? ' Nothing else is needed.' : ''),
    )
  }
  return parts.length === 0 ? undefined : `[cc-accounts] ${parts.join(' ')}`
}
