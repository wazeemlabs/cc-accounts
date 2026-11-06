// /account usage: what is free on every account, when it comes back, and
// where each project's sessions run. Every account shown is a share of the
// same kind of plan, so free room adds up in Max 5x plans: a Max 20x counts
// four, a Pro a fifth.
import type { EngineInterface } from 'claude-code'
import type { Context } from './context'
import { holdsOf } from './failures'
import { projectName, readPriorities, weightOf, DEFAULT_WEIGHT, type Priorities } from './priorities'
import { accountStates, liveSessions, type AccountState, type LiveSession } from './survey'
import { percentNow, POLICY, windowAtLimit, windowName, type Reading } from './usage'

export type ReportInput = {
  now: number
  accounts: { state: AccountState; holds: { scope: string; until: number }[] }[]
  live: readonly LiveSession[]
  priorities: Priorities
  current: string | undefined
  defaultName: string | undefined
}

// How long until `at`: `3d 4h`, `2h 9m`, `20m`, `under a minute`.
export function untilText(at: number, now: number): string {
  const minutes = Math.floor((at - now) / 60_000)
  if (minutes < 1) return 'under a minute'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

function resetIn(reading: Reading, kind: string, now: number): string {
  const resetsAt = reading.windows[kind]?.resetsAt
  const at = resetsAt === undefined ? NaN : Date.parse(resetsAt)
  return Number.isNaN(at) || at <= now ? '-' : untilText(at, now)
}

export type Totals = { accounts: number; free: Record<string, number>; beforeMoves: Record<string, number> }

// Free room over the accounts that can serve a session now (signed in,
// measured, with no window spent and no hold on the whole account), in Max
// 5x plans; and how much of it is left before sessions move off (the leave
// line).
export function totals(input: ReportInput): Totals {
  const found: Totals = { accounts: 0, free: { five_hour: 0, seven_day: 0 }, beforeMoves: { five_hour: 0, seven_day: 0 } }
  for (const { state, holds } of input.accounts) {
    const { reading, units } = state
    if (state.email === undefined || reading === undefined || windowAtLimit(reading, input.now) !== undefined) continue
    if (holds.some(hold => hold.scope === 'account')) continue
    found.accounts += 1
    for (const kind of Object.keys(found.free)) {
      const used = percentNow(reading, kind, input.now)
      found.free[kind]! += (units * (100 - used)) / 100
      found.beforeMoves[kind]! += (units * Math.max(0, POLICY.leave[kind]! - used)) / 100
    }
  }
  return found
}

const number = (value: number) => value.toFixed(2)

export function totalsLine(found: Totals): string {
  return `Free now, in Max 5x plans: ${number(found.free.five_hour!)} of the 5-hour windows and ` +
    `${number(found.free.seven_day!)} of the weeks, over ${found.accounts} account${found.accounts === 1 ? '' : 's'}.`
}

function pad(text: string, width: number, right = false): string {
  return right ? text.padStart(width) : text.padEnd(width)
}

function accountLine(input: ReportInput, row: ReportInput['accounts'][number]): string {
  const { state, holds } = row
  const name = state.account.name
  const live = input.live.filter(session => session.account === name)
  const load = live.reduce((sum, session) => sum + weightOf(input.priorities, session.cwd).weight, 0)
  const notes = [
    live.length === load ? `${live.length}` : `${live.length} (load ${load})`,
    ...holds.map(hold => `${hold.scope === 'account' ? 'held' : `${hold.scope} held`} ${untilText(hold.until, input.now)}`),
    state.sized ? '' : 'plan size unknown, counted as one Max 5x',
    name === input.current ? '← this session' : '',
    name === input.defaultName ? '← new sessions' : '',
  ].filter(note => note !== '')
  const head = pad(name, 12)
  if (state.email === undefined) return `${head}not signed in`
  const { reading } = state
  if (reading === undefined) return `${head}no reading yet; ${notes.join(', ')}`
  const spent = windowAtLimit(reading, input.now)
  if (spent !== undefined) {
    return `${head}spent until its ${windowName(spent)} window resets in ${resetIn(reading, spent, input.now)}; ${notes.join(', ')}`
  }
  const free = (kind: string) => `${Math.round(100 - percentNow(reading, kind, input.now))}%`
  return head + pad(free('five_hour'), 11, true) + pad(resetIn(reading, 'five_hour', input.now), 11, true) +
    pad(free('seven_day'), 11, true) + pad(resetIn(reading, 'seven_day', input.now), 11, true) + `   ${notes.join(', ')}`
}

function projectLines(input: ReportInput): string[] {
  const projects = new Map<string, { weight: number; sessions: number; accounts: string[] }>()
  for (const session of input.live) {
    const { weight, folder } = weightOf(input.priorities, session.cwd)
    const key = folder ?? session.cwd
    const project = projects.get(key) ?? { weight, sessions: 0, accounts: [] }
    project.sessions += 1
    if (!project.accounts.includes(session.account)) project.accounts.push(session.account)
    projects.set(key, project)
  }
  const rows = [...projects.entries()].sort(([a, x], [b, y]) => y.weight - x.weight || projectName(a).localeCompare(projectName(b)))
  return [
    `${pad('project', 24)}${pad('priority', 9, true)}${pad('sessions', 10, true)}   on`,
    ...rows.map(([folder, project]) =>
      pad(projectName(folder), 24) + pad(String(project.weight), 9, true) + pad(String(project.sessions), 10, true) +
        `   ${project.accounts.join(', ')}`),
  ]
}

export function formatReport(input: ReportInput): string {
  const found = totals(input)
  const set = [...input.priorities.entries()].filter(([, weight]) => weight !== DEFAULT_WEIGHT)
  return [
    `${pad('account', 12)}${pad('5-hour free', 11, true)}${pad('resets in', 11, true)}${pad('week free', 11, true)}` +
      `${pad('resets in', 11, true)}   sessions`,
    ...input.accounts.map(row => accountLine(input, row)),
    '',
    totalsLine(found),
    `Free before sessions move off (5-hour ${POLICY.leave.five_hour}%, week ${POLICY.leave.seven_day}%): ` +
      `${number(found.beforeMoves.five_hour!)} and ${number(found.beforeMoves.seven_day!)}.`,
    '',
    ...(input.live.length === 0 ? ['No live sessions.'] : projectLines(input)),
    set.length === 0
      ? `Every project counts at ${DEFAULT_WEIGHT}. Weigh one with /account priority <weight> [folder].`
      : 'Change a weight with /account priority <weight> [folder]; 1 is the default.',
  ].join('\n')
}

// What /account usage shows, read now.
export async function gatherReport(
  $: EngineInterface,
  ctx: Context,
  defaultName: string | undefined,
): Promise<ReportInput> {
  const now = await $.clock.now()
  const states = await accountStates($, ctx)
  return {
    now,
    accounts: await Promise.all(states.map(async state => ({ state, holds: await holdsOf($, ctx.root, state.account.name, now) }))),
    live: await liveSessions($, ctx),
    priorities: await readPriorities($, ctx.root),
    current: ctx.current?.name,
    defaultName,
  }
}
