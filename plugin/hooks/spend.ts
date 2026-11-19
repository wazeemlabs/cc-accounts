// What sessions spend and what a point is worth. Every session records what
// its turns cost (spend/<day>/<session>.json, in tokens weighted by model, by
// the folder each was spent in), a client outside Claude Code records its
// calls (cca spend), and each account's readings say how much of its week it
// consumed on a day (calibration/<day>/<account>.json), so tokens are counted
// in points, one percent of a Max 5x week. budgets.ts holds projects to
// their allowance in those points.
import type { EngineInterface } from 'claude-code'
import { writeAtomic } from './context'
import { familyOf } from './failures'
import type { Reading } from './usage'

export const DAY_MS = 24 * 3_600_000

// What each model family's tokens cost against the week, relative to Opus:
// the plan's own rates are not published, so these are the API price ratios
// (Fable's is assumed).
export const FAMILY_WEIGHTS: Readonly<Record<string, number>> = { opus: 1, fable: 2, sonnet: 0.6, haiku: 0.2 }
// How the four token counts weigh against uncached input, as the API prices them.
const CACHE_READ = 0.1
const CACHE_WRITE = 1.25
const OUTPUT = 5

// Weighted tokens per point until the accounts have shown their own ratio
// (measured 2026-11-06 over five Max 5x accounts), and how many points of
// consumption the measurement needs before it is trusted.
export const DEFAULT_TOKENS_PER_POINT = 7_000_000
export const CALIBRATION_POINTS = 10
export const CALIBRATION_DAYS = 3

export function spendDir(root: string, day: string): string {
  return `${root}/spend/${day}`
}

export function calibrationFile(root: string, day: string, account: string): string {
  return `${root}/calibration/${day}/${account}.json`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The UTC day `at` falls in, `2026-11-07`.
export function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

// The days to read for a window of `days` days ending at `at`.
export function daysBack(at: number, days: number): string[] {
  return Array.from({ length: days }, (_, index) => dayOf(at - index * DAY_MS))
}

// What a turn cost, in tokens weighted by model and by kind of token.
export function weightedTokens(usage: {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}): number {
  const family = familyOf(usage.model)
  const weight = (family === undefined ? undefined : FAMILY_WEIGHTS[family]) ?? 1
  return weight * (
    usage.input_tokens + CACHE_READ * usage.cache_read_input_tokens +
    CACHE_WRITE * usage.cache_creation_input_tokens + OUTPUT * usage.output_tokens
  )
}

// One session's or client's spend on one day, in weighted tokens; a client's
// names the account it called, which no session of its own may be measuring.
export type Spend = { cwd: string; tokens: number; account?: string }

const TOKEN_KINDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const

// A day's record: a session's own (`tokens`, weighted as each turn ended),
// or a client's from `cca spend` (`usage`, raw counts per model, weighted
// here so a token's cost has one definition). Undefined when it is neither.
export function parseSpend(text: string): Spend | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(value) || typeof value.cwd !== 'string') return undefined
  if (typeof value.tokens === 'number') return { cwd: value.cwd, tokens: value.tokens }
  if (!isObject(value.usage)) return undefined
  let tokens = 0
  for (const [model, counts] of Object.entries(value.usage)) {
    if (!isObject(counts)) return undefined
    const read = TOKEN_KINDS.map((kind) => counts[kind])
    if (!read.every((count): count is number => typeof count === 'number' && Number.isFinite(count) && count >= 0)) return undefined
    const [input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens] = read
    tokens += weightedTokens({ model, input_tokens: input_tokens!, output_tokens: output_tokens!, cache_read_input_tokens: cache_read_input_tokens!, cache_creation_input_tokens: cache_creation_input_tokens! })
  }
  if (typeof value.account !== 'string') return undefined
  return { cwd: value.cwd, tokens, account: value.account }
}

// A session's record of the day, by the folder each token was spent in: a
// session that moves (a /cd, a worktree, the desktop app's move out of its
// standby folder) took the whole day's spend to its new project when the
// record held one folder (2026-11-15 review). Reads the one-folder records
// earlier versions wrote. Undefined for anything else (a client's record).
export function sessionFolders(text: string): Map<string, number> | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(value)) return undefined
  if (isObject(value.folders)) {
    const folders = new Map<string, number>()
    for (const [folder, tokens] of Object.entries(value.folders)) {
      if (!folder.startsWith('/') || typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return undefined
      folders.set(folder, tokens)
    }
    return folders
  }
  return typeof value.cwd === 'string' && typeof value.tokens === 'number' ? new Map([[value.cwd, value.tokens]]) : undefined
}

// Adds a turn's cost to this session's record of the day, under the folder
// it works in now. Only this session writes its file, so there is no one to
// race.
export async function recordSpend(
  $: EngineInterface,
  root: string,
  sessionId: string,
  cwd: string,
  at: number,
  tokens: number,
): Promise<void> {
  const file = `${spendDir(root, dayOf(at))}/${sessionId}.json`
  const folders = ((await $.fs.exists(file)) ? sessionFolders(await $.fs.read(file)) : undefined) ?? new Map<string, number>()
  folders.set(cwd, (folders.get(cwd) ?? 0) + tokens)
  await writeAtomic($, file, `${JSON.stringify({ folders: Object.fromEntries(folders) })}\n`)
}

// Every session's and client's spend on `day`: a session's one entry for
// each folder it spent in.
export async function readSpend($: EngineInterface, root: string, day: string): Promise<Map<string, Spend>> {
  const dir = spendDir(root, day)
  const found = new Map<string, Spend>()
  if (!(await $.fs.exists(dir))) return found
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    let text: string
    try {
      text = await $.fs.read(`${dir}/${entry.name}`)
    } catch {
      // Gone since the listing: one turn's cost uncounted until the next.
      continue
    }
    const id = entry.name.slice(0, -'.json'.length)
    const folders = sessionFolders(text)
    if (folders !== undefined) {
      for (const [cwd, tokens] of folders) found.set(`${id}\t${cwd}`, { cwd, tokens })
      continue
    }
    // A client's record, or one caught mid-write: that turn's cost uncounted until the next.
    const spend = parseSpend(text)
    if (spend !== undefined) found.set(id, spend)
  }
  return found
}

// How much of its week an account was seen to use on a day: the highest
// weekly reading of the week in progress, the moment that week resets, and
// the points consumed since the day's first reading, summed over the rises
// between readings.
export type Calibration = { last: number; consumed: number; resetsAt?: string }

export function parseCalibration(text: string): Calibration | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(value) || typeof value.last !== 'number' || typeof value.consumed !== 'number') return undefined
  if (value.resetsAt !== undefined && typeof value.resetsAt !== 'string') return undefined
  return value.resetsAt === undefined
    ? { last: value.last, consumed: value.consumed }
    : { last: value.last, consumed: value.consumed, resetsAt: value.resetsAt }
}

// The day's record after a reading of `percent` for the week resetting at
// `resetsAt`. Only a reset moment at least a day later starts a new week,
// whose reading counts from zero; the moment a reading reports can drift by
// seconds within one week. A lower reading of the same week is another
// session's older view of it and adds nothing: counting it as a fresh week
// once tripled a day's points and parked a project within its budget.
// Two sessions measuring at the same moment can drop one increment, which
// undercounts the points: spend is then counted low, never high.
export function calibrated(before: Calibration | undefined, percent: number, resetsAt?: string): Calibration {
  const at = resetsAt === undefined ? {} : { resetsAt }
  if (before === undefined) return { last: percent, consumed: 0, ...at }
  const recordedReset = before.resetsAt === undefined ? NaN : Date.parse(before.resetsAt)
  const readingReset = resetsAt === undefined ? NaN : Date.parse(resetsAt)
  if (readingReset - recordedReset >= DAY_MS) return { last: percent, consumed: before.consumed + percent, ...at }
  // A reading of the week before, which a session reports after the new
  // week's first one, says nothing of this week.
  if (recordedReset - readingReset >= DAY_MS) return before
  const kept = before.resetsAt === undefined ? at : { resetsAt: before.resetsAt }
  if (percent <= before.last) return { last: before.last, consumed: before.consumed, ...kept }
  return { last: percent, consumed: before.consumed + percent - before.last, ...kept }
}

export async function recordCalibration($: EngineInterface, root: string, reading: Reading): Promise<void> {
  const window = reading.windows.seven_day
  if (window === undefined) return
  const file = calibrationFile(root, dayOf(reading.at), reading.account)
  const before = (await $.fs.exists(file)) ? parseCalibration(await $.fs.read(file)) : undefined
  await writeAtomic($, file, `${JSON.stringify(calibrated(before, window.percentUsed, window.resetsAt))}\n`)
}

// Weighted tokens per point, from the last CALIBRATION_DAYS days: every
// session's tokens over every account's consumption, when the accounts
// consumed enough to trust; else the default. A client's tokens count only on
// a day its account was measured: an account only a client used reports no
// consumption, and its tokens alone would make every point look larger.
export async function tokensPerPoint($: EngineInterface, root: string, accounts: readonly string[], at: number): Promise<number> {
  let tokens = 0
  let points = 0
  for (const day of daysBack(at, CALIBRATION_DAYS)) {
    const measured = new Set<string>()
    for (const account of accounts) {
      const file = calibrationFile(root, day, account)
      if (!(await $.fs.exists(file))) continue
      measured.add(account)
      points += parseCalibration(await $.fs.read(file))?.consumed ?? 0
    }
    for (const spend of (await readSpend($, root, day)).values()) {
      if (spend.account === undefined || measured.has(spend.account)) tokens += spend.tokens
    }
  }
  return points >= CALIBRATION_POINTS && tokens > 0 ? tokens / points : DEFAULT_TOKENS_PER_POINT
}

// Points an hour, from `points` consumed over `days` whole days; undefined
// when no day was read.
export function demandRate(points: number | undefined, days: number): number | undefined {
  return points === undefined ? undefined : points / (days * 24)
}

// What the accounts together have been spending, in points an hour (a point
// being one percent of a Max 5x week, so an account's consumption counts by
// its plan size): the CALIBRATION_DAYS whole days before today, today being
// part of a day. Undefined with no day on record. Days with no record count
// as nothing spent, which reads low, and a low figure moves sessions to an
// ending week sooner, never later.
export async function demandPerHour(
  $: EngineInterface,
  root: string,
  accounts: readonly { name: string; units: number }[],
  at: number,
): Promise<number | undefined> {
  let points: number | undefined
  for (const day of daysBack(at - DAY_MS, CALIBRATION_DAYS)) {
    for (const account of accounts) {
      const file = calibrationFile(root, day, account.name)
      if (!(await $.fs.exists(file))) continue
      points = (points ?? 0) + (parseCalibration(await $.fs.read(file))?.consumed ?? 0) * account.units
    }
  }
  return demandRate(points, CALIBRATION_DAYS)
}

// A session that has spent less than this over the days read has not shown
// what it spends: about a seventh of a point of a Max 5x week.
export const SHARE_MIN_TOKENS = 1_000_000
// A day or two of spend is a rough guide to the next hours, so no session
// counts as less than a quarter of an average one or more than four.
export const SHARE_RANGE = { least: 0.25, most: 4 }

// Each session's spend over the average of `ids`' (the working sessions),
// from `tokens` spent by session id. A session with too little on record is
// left out and counts as one; so does every session when fewer than two can
// be compared.
export function spendShares(ids: readonly string[], tokens: ReadonlyMap<string, number>): Map<string, number> {
  const measured = ids.flatMap(id => {
    const spent = tokens.get(id)
    return spent !== undefined && spent >= SHARE_MIN_TOKENS ? [{ id, spent }] : []
  })
  if (measured.length < 2) return new Map()
  const mean = measured.reduce((sum, session) => sum + session.spent, 0) / measured.length
  return new Map(measured.map(({ id, spent }) => [id, Math.min(SHARE_RANGE.most, Math.max(SHARE_RANGE.least, spent / mean))]))
}

// What each record's owner has spent today and yesterday, in weighted
// tokens, by id (a session's is its session id): today alone is too short just after midnight UTC.
export async function sessionTokens($: EngineInterface, root: string, at: number): Promise<Map<string, number>> {
  const found = new Map<string, number>()
  for (const day of daysBack(at, 2)) {
    for (const [key, spend] of await readSpend($, root, day)) {
      // Keyed by id and folder. A record of anything but a working session is never looked up.
      const id = key.split('\t')[0]!
      found.set(id, (found.get(id) ?? 0) + spend.tokens)
    }
  }
  return found
}
