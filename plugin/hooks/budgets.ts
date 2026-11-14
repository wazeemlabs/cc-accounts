// Daily budgets per project, so that several projects last the whole week
// on the accounts they share. A point is one percent of a Max 5x week. Each
// UTC day the accounts supply so many points (their room spread until each
// resets); a project with a budget (`/account budget`) gets that many a day,
// and the projects without one share what is left by their weights
// (priorities.ts). Every session records what its turns cost
// (spend/<day>/<session>.json, in tokens weighted by model), and an account's
// readings say how many points those tokens came to (calibration/<day>/
// <account>.json), so spend is counted in points. A project that has spent
// more than its day's allowance so far, a quarter of a day ahead, is over
// budget: its sessions are parked between turns (register.ts refuses their
// tool calls) until the allowance catches up or the day turns.
import type { EngineInterface } from 'claude-code'
import { describeError, writeAtomic } from './context'
import { familyOf } from './failures'
import { nearestFolder, projectName, readPriorities, weightOf, type Priorities } from './priorities'
import { accountStates, liveSessions, type AccountState, type LiveSession } from './survey'
import type { Context } from './context'
import { percentNow, POLICY, type Reading } from './usage'

export type Budgets = ReadonlyMap<string, number>

export const DAY_MS = 24 * 3_600_000
export const WEEK_MS = 7 * DAY_MS
export const MAX_BUDGET = 10_000

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

// How far ahead of the day's clock a project may run: a quarter of its
// allowance, so a burst at the start of the day is not parked at once.
export const BURST = 0.25

// Points a day the Claude desktop app's folderless sessions share once any
// budget is set. Each such session starts in a scratch folder of its own, so
// without this each would be a project with no budget, sharing what the
// budgets leave, which is nothing once they add up to the supply: such a
// session was parked from its first turn (2026-11-14). A budget set on the
// scratch folder replaces it.
export const SCRATCH_BUDGET = 5

export const POLICY_BUDGET = { calibrationDays: CALIBRATION_DAYS, burst: BURST, scratch: SCRATCH_BUDGET }

// Where the Claude desktop app starts a session opened without a folder: a
// folder of its own somewhere under this one.
export function scratchRoot(home: string): string {
  return `${home}/Library/Application Support/Claude/scratch-workspaces`
}

export function budgetFile(root: string): string {
  return `${root}/budgets.json`
}

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

// When the UTC day `at` falls in ends.
export function dayEnd(at: number): number {
  return Date.parse(`${dayOf(at)}T00:00:00Z`) + DAY_MS
}

// The days to read for a window of `days` days ending at `at`.
export function daysBack(at: number, days: number): string[] {
  return Array.from({ length: days }, (_, index) => dayOf(at - index * DAY_MS))
}

// A budget as the person typed it (`35`, `12.5`), or undefined when it is
// not a number of points per day above 0 and at most MAX_BUDGET.
export function parseBudget(text: string): number | undefined {
  if (!/^[0-9]+(\.[0-9]+)?$/.test(text)) return undefined
  const points = Number(text)
  return points > 0 && points <= MAX_BUDGET ? points : undefined
}

// The file's budgets, or undefined when it is not a budgets file.
export function parseBudgets(text: string): Map<string, number> | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Not JSON: the caller reports it and no project has a budget.
    return undefined
  }
  if (!isObject(value)) return undefined
  const budgets = new Map<string, number>()
  for (const [folder, points] of Object.entries(value)) {
    if (!folder.startsWith('/') || typeof points !== 'number' || !(points > 0 && points <= MAX_BUDGET)) return undefined
    budgets.set(folder, points)
  }
  return budgets
}

export function formatBudgets(budgets: Budgets): string {
  const sorted = [...budgets.entries()].sort(([a], [b]) => a.localeCompare(b))
  return `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`
}

export async function readBudgets($: EngineInterface, root: string): Promise<Map<string, number>> {
  const file = budgetFile(root)
  if (!(await $.fs.exists(file))) return new Map()
  let text: string
  try {
    text = await $.fs.read(file)
  } catch (error) {
    $.ui.log(`cc-accounts: could not read ${file} (${describeError(error)}); no project has a budget.`)
    return new Map()
  }
  const budgets = parseBudgets(text)
  if (budgets === undefined) {
    $.ui.log(`cc-accounts: ${file} is not a budgets file; no project has a budget.`)
    return new Map()
  }
  return budgets
}

// The budgets that hold: the file's, and SCRATCH_BUDGET for the scratch
// folder when any budget is set and none names it. With none set, nothing
// is parked, folderless sessions included.
export function budgetsInForce(budgets: Budgets, home: string): Map<string, number> {
  const found = new Map(budgets)
  const scratch = scratchRoot(home)
  if (found.size > 0 && !found.has(scratch)) found.set(scratch, SCRATCH_BUDGET)
  return found
}

export async function readBudgetsInForce($: EngineInterface, ctx: Context): Promise<Map<string, number>> {
  return budgetsInForce(await readBudgets($, ctx.root), ctx.home)
}

// Sets `folder`'s budget; 0 removes it.
export async function setBudget($: EngineInterface, root: string, folder: string, points: number): Promise<void> {
  const budgets = await readBudgets($, root)
  if (points === 0) budgets.delete(folder)
  else budgets.set(folder, points)
  await writeAtomic($, budgetFile(root), formatBudgets(budgets))
}

// The project a session in `cwd` belongs to, for budgets: the nearest folder
// with a budget at or above it, else the nearest with a weight, else `cwd`.
export function projectOf(budgets: Budgets, priorities: Priorities, cwd: string): string {
  return nearestFolder(budgets, cwd) ?? weightOf(priorities, cwd).folder ?? cwd
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

// Adds a turn's cost to this session's record of the day. Only this session
// writes its file, so there is no one to race.
export async function recordSpend(
  $: EngineInterface,
  root: string,
  sessionId: string,
  cwd: string,
  at: number,
  tokens: number,
): Promise<void> {
  const file = `${spendDir(root, dayOf(at))}/${sessionId}.json`
  const before = (await $.fs.exists(file)) ? parseSpend(await $.fs.read(file)) : undefined
  await writeAtomic($, file, `${JSON.stringify({ cwd, tokens: (before?.tokens ?? 0) + tokens })}\n`)
}

// Every session's spend on `day`, keyed by session id.
export async function readSpend($: EngineInterface, root: string, day: string): Promise<Map<string, Spend>> {
  const dir = spendDir(root, day)
  const found = new Map<string, Spend>()
  if (!(await $.fs.exists(dir))) return found
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    let spend: Spend | undefined
    try {
      spend = parseSpend(await $.fs.read(`${dir}/${entry.name}`))
    } catch {
      // Gone since the listing, or caught mid-write: one turn's cost uncounted until the next.
      continue
    }
    if (spend !== undefined) found.set(entry.name.slice(0, -'.json'.length), spend)
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

// The points an account can give in the next day: its room below the leave
// line spread evenly until its week resets, and a fresh week's share after
// that; a plan's steady share (99 points a week) when it has no reading.
export function dailySupplyOf(state: AccountState, now: number): number {
  const steady = (POLICY.leave.seven_day! / 7) * state.units
  if (state.email === undefined) return 0
  const { reading } = state
  if (reading === undefined || reading.windows.seven_day === undefined) return steady
  const room = Math.max(0, POLICY.leave.seven_day! - percentNow(reading, 'seven_day', now)) * state.units
  const resetsAt = reading.windows.seven_day.resetsAt
  const resets = resetsAt === undefined ? NaN : Date.parse(resetsAt)
  const until = Number.isNaN(resets) ? WEEK_MS : Math.max(0, resets - now)
  if (until <= 0) return steady
  if (until >= DAY_MS) return (room * DAY_MS) / until
  return room + (steady * (DAY_MS - until)) / DAY_MS
}

export type ProjectBudget = {
  folder: string
  // Points a day: set with /account budget, or the project's share of the rest.
  allowance: number
  budgeted: boolean
  // Budgeted by SCRATCH_BUDGET, not by the file.
  byDefault: boolean
  spent: number
  // What the project may have spent by now, this far into the day plus the burst.
  allowedNow: number
  sessions: number
}

export type Plan = {
  supply: number
  tokensPerPoint: number
  dayEnd: number
  projects: ProjectBudget[]
}

// The day's plan: every project with a budget or a live session, its
// allowance and what it has spent.
export function plan(
  now: number,
  states: readonly AccountState[],
  live: readonly LiveSession[],
  spend: ReadonlyMap<string, Spend>,
  budgets: Budgets,
  priorities: Priorities,
  perPoint: number,
): Plan {
  const supply = states.reduce((sum, state) => sum + dailySupplyOf(state, now), 0)
  const projects = new Map<string, ProjectBudget>()
  const project = (folder: string): ProjectBudget => {
    const found = projects.get(folder)
    if (found !== undefined) return found
    const made = { folder, allowance: 0, budgeted: budgets.has(folder), byDefault: false, spent: 0, allowedNow: 0, sessions: 0 }
    projects.set(folder, made)
    return made
  }
  for (const folder of budgets.keys()) project(folder)
  for (const session of live) project(projectOf(budgets, priorities, session.cwd)).sessions += 1
  for (const record of spend.values()) project(projectOf(budgets, priorities, record.cwd)).spent += record.tokens / perPoint
  const reserved = [...budgets.values()].reduce((sum, points) => sum + points, 0)
  const sharing = [...projects.values()].filter(found => !found.budgeted && found.sessions > 0)
  const weights = sharing.reduce((sum, found) => sum + weightOf(priorities, found.folder).weight, 0)
  const left = Math.max(0, supply - reserved)
  const elapsed = 1 - (dayEnd(now) - now) / DAY_MS
  for (const found of projects.values()) {
    found.allowance = found.budgeted
      ? budgets.get(found.folder)!
      : found.sessions > 0 && weights > 0 ? (left * weightOf(priorities, found.folder).weight) / weights : 0
    found.allowedNow = found.allowance * Math.min(1, elapsed + BURST)
  }
  return { supply, tokensPerPoint: perPoint, dayEnd: dayEnd(now), projects: [...projects.values()] }
}

// Whether the project of `cwd` is over its allowance so far, with its figures.
export function over(found: Plan, budgets: Budgets, priorities: Priorities, cwd: string): ProjectBudget | undefined {
  const folder = projectOf(budgets, priorities, cwd)
  const project = found.projects.find(candidate => candidate.folder === folder)
  return project !== undefined && project.spent >= project.allowedNow ? project : undefined
}

const points = (value: number) => (Math.round(value * 10) / 10).toString()

// Why a parked session's tool calls are refused.
export function parkedText(project: ProjectBudget, found: Plan, now: number): string {
  const minutes = Math.max(1, Math.round((found.dayEnd - now) / 60_000))
  const when = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`
  return `cc-accounts: ${projectName(project.folder)} has spent ${points(project.spent)} of the ${points(project.allowance)} ` +
    `points its sessions may use today (${points(project.allowedNow)} by now). This session is parked until the ` +
    `allowance catches up or the UTC day turns in ${when}. Stop here; do not retry.`
}

// The budgets section of /account usage and /account budget.
export function budgetLines(found: Plan, current: string | undefined, now: number): string[] {
  const pad = (text: string, width: number, right = false) => (right ? text.padStart(width) : text.padEnd(width))
  const rows = [...found.projects].sort((a, b) => b.allowance - a.allowance || projectName(a.folder).localeCompare(projectName(b.folder)))
  const minutes = Math.max(0, Math.round((found.dayEnd - now) / 60_000))
  return [
    `Budgets, in points (1% of a Max 5x week) per UTC day; the accounts supply about ${points(found.supply)} today, ` +
      `and a point is about ${(found.tokensPerPoint / 1e6).toFixed(1)} M weighted tokens. The day turns in ` +
      `${Math.floor(minutes / 60)}h ${minutes % 60}m.`,
    `${pad('project', 24)}${pad('a day', 8, true)}${pad('spent', 8, true)}${pad('by now', 8, true)}${pad('sessions', 10, true)}   `,
    ...rows.map(project =>
      pad(projectName(project.folder), 24) + pad(points(project.allowance), 8, true) + pad(points(project.spent), 8, true) +
        pad(points(project.allowedNow), 8, true) + pad(String(project.sessions), 10, true) +
        `   ${[
          project.byDefault ? 'default for sessions with no folder' : project.budgeted ? 'set' : 'share of the rest',
          project.spent >= project.allowedNow ? 'over: parked' : '',
          project.folder === current ? '← this project' : '',
        ].filter(note => note !== '').join(', ')}`),
  ]
}

// The plan as it stands now, read from every file it rests on.
export async function currentPlan($: EngineInterface, ctx: Context, now: number): Promise<Plan> {
  const [states, live, spend, set, priorities] = await Promise.all([
    accountStates($, ctx),
    liveSessions($, ctx),
    readSpend($, ctx.root, dayOf(now)),
    readBudgets($, ctx.root),
    readPriorities($, ctx.root),
  ])
  const perPoint = await tokensPerPoint($, ctx.root, ctx.accounts.map(account => account.name), now)
  const found = plan(now, states, live, spend, budgetsInForce(set, ctx.home), priorities, perPoint)
  for (const project of found.projects) project.byDefault = project.budgeted && !set.has(project.folder)
  return found
}

// Whether this session's project is over its allowance now; undefined when
// budgets are off (CCA_BUDGET=off) or no budget is set, since with none set
// every project's allowance is the whole supply shared, which parks only a
// project that has outspent the accounts.
export async function parkedNow($: EngineInterface, ctx: Context, cwd: string, now: number): Promise<{ project: ProjectBudget; plan: Plan } | undefined> {
  if ((await $.env.get('CCA_BUDGET')) === 'off') return undefined
  const budgets = await readBudgetsInForce($, ctx)
  if (budgets.size === 0) return undefined
  const found = await currentPlan($, ctx, now)
  const project = over(found, budgets, await readPriorities($, ctx.root), cwd)
  return project === undefined ? undefined : { project, plan: found }
}
