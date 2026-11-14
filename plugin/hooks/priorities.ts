// How much each project matters, as the person set it with /account priority.
// priorities.json maps a folder to its weight. A session's project is the
// folder it works in ($.session.root(), which follows the desktop app moving
// a session out of the standby folder it started in): it takes the weight of that folder or of the nearest
// folder above it that has one, else 1. Weights steer the balancer
// (usage.ts): a session counts by its weight on the account it runs on, so
// sessions that matter less keep off accounts where heavier ones run, and
// make room for them when the account runs low.
import type { EngineInterface } from 'claude-code'
import { describeError, writeAtomic } from './context'
import type { LiveSession } from './survey'

export const DEFAULT_WEIGHT = 1
export const MAX_WEIGHT = 100

export type Priorities = ReadonlyMap<string, number>

export function priorityFile(root: string): string {
  return `${root}/priorities.json`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A weight as the person typed it (`3`, `0.5`), or undefined when it is not
// a number above 0 and at most MAX_WEIGHT.
export function parseWeight(text: string): number | undefined {
  if (!/^[0-9]+(\.[0-9]+)?$/.test(text)) return undefined
  const weight = Number(text)
  return weight > 0 && weight <= MAX_WEIGHT ? weight : undefined
}

// A folder as the file keys it, the way a session's folder reads: absolute,
// `~` expanded, `.` and `..` resolved, no doubled or trailing slash.
// Undefined for a relative path, which names no one folder.
export function normalizeFolder(path: string, home: string): string | undefined {
  const expanded = path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path
  if (!expanded.startsWith('/')) return undefined
  const parts: string[] = []
  for (const part of expanded.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '' && part !== '.') parts.push(part)
  }
  return `/${parts.join('/')}`
}

// The file's weights, or undefined when it is not a priorities file.
export function parsePriorities(text: string): Map<string, number> | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Not JSON: the caller reports it and counts every project at 1.
    return undefined
  }
  if (!isObject(value)) return undefined
  const priorities = new Map<string, number>()
  for (const [folder, weight] of Object.entries(value)) {
    if (!folder.startsWith('/') || typeof weight !== 'number' || !(weight > 0 && weight <= MAX_WEIGHT)) return undefined
    priorities.set(folder, weight)
  }
  return priorities
}

export function formatPriorities(priorities: Priorities): string {
  const sorted = [...priorities.entries()].sort(([a], [b]) => a.localeCompare(b))
  return `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`
}

// The weight a session working in `cwd` takes, and the folder that set it
// (undefined for the default).
export function weightOf(priorities: Priorities, cwd: string): { weight: number; folder: string | undefined } {
  const folder = nearestFolder(priorities, cwd)
  return folder === undefined ? { weight: DEFAULT_WEIGHT, folder: undefined } : { weight: priorities.get(folder)!, folder }
}

// The nearest folder in `folders` at or above `cwd`, or undefined.
export function nearestFolder(folders: ReadonlyMap<string, unknown>, cwd: string): string | undefined {
  let found: string | undefined
  for (const folder of folders.keys()) {
    const covers = cwd === folder || cwd.startsWith(folder === '/' ? '/' : `${folder}/`)
    if (covers && (found === undefined || folder.length > found.length)) found = folder
  }
  return found
}

export async function readPriorities($: EngineInterface, root: string): Promise<Map<string, number>> {
  const file = priorityFile(root)
  if (!(await $.fs.exists(file))) return new Map()
  let text: string
  try {
    text = await $.fs.read(file)
  } catch (error) {
    $.ui.log(`cc-accounts: could not read ${file} (${describeError(error)}); every project counts at ${DEFAULT_WEIGHT}.`)
    return new Map()
  }
  const priorities = parsePriorities(text)
  if (priorities === undefined) {
    $.ui.log(`cc-accounts: ${file} is not a priorities file; every project counts at ${DEFAULT_WEIGHT}.`)
    return new Map()
  }
  return priorities
}

// Sets `folder`'s weight; the default weight removes its entry.
export async function setPriority($: EngineInterface, root: string, folder: string, weight: number): Promise<void> {
  const priorities = await readPriorities($, root)
  if (weight === DEFAULT_WEIGHT) priorities.delete(folder)
  else priorities.set(folder, weight)
  await writeAtomic($, priorityFile(root), formatPriorities(priorities))
}

// Each account's load: the summed weights of the working sessions on it.
export function loads(live: readonly LiveSession[], priorities: Priorities): Map<string, number> {
  const found = new Map<string, number>()
  for (const session of live) {
    // An idle session spends nothing, so it weighs on no account's window.
    if (!session.active) continue
    found.set(session.account, (found.get(session.account) ?? 0) + weightOf(priorities, session.cwd).weight)
  }
  return found
}

// The heaviest other working session on `account` that outweighs `weight`,
// with the folder that gave it its weight, or undefined when none does. An
// idle one spends nothing, so nothing makes room for it.
export function heavierOn(
  live: readonly LiveSession[],
  priorities: Priorities,
  account: string,
  self: string,
  weight: number,
): { session: LiveSession; weight: number; folder: string } | undefined {
  let found: { session: LiveSession; weight: number; folder: string } | undefined
  for (const session of live) {
    if (session.account !== account || session.sessionId === self || !session.active) continue
    const other = weightOf(priorities, session.cwd)
    if (other.weight > weight && (found === undefined || other.weight > found.weight)) {
      found = { session, weight: other.weight, folder: other.folder ?? session.cwd }
    }
  }
  return found
}

// The last segment of a folder, as a project is named to the person.
export function projectName(folder: string): string {
  return folder.split('/').filter(part => part !== '').at(-1) ?? folder
}
