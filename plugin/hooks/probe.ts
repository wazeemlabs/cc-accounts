// Asking an account that reads full whether it still is.
//
// A reading comes only from a session running on its account (survey.ts), so
// an account every session has left keeps its last one until the reset that
// reading names. A limit can be lifted sooner: a person can reset an
// account's limits from the account itself, and no session is there to see
// it (2026-11-24: an account reset by hand read "week 100%" for hours while
// every session sat on spent accounts). So a session that must leave its
// account and finds no room asks each account that reads full: one short
// request on it through cca. Claude Code refuses the request on a spent
// account before any model runs, so it costs nothing there, and the plugin
// in that run saves the reading the reply carries either way, for every
// session to see.
//
// An account is asked at most once in PROBE_MS, by whichever session gets
// there first (probes/<account> holds when).
import type { EngineInterface } from 'claude-code'
import { describeError, run, writeAtomic, type Context } from './context'
import { fullWindow, type Candidate } from './usage'

export const PROBE_MS = 10 * 60_000

// A refused request answers in seconds; one that waits this long has hung.
const PROBE_TIMEOUT_MS = 60_000

const PROMPT = 'Reply with the single word ok.'

export function probeFile(root: string, account: string): string {
  return `${root}/probes/${account}`
}

// What asks `account`: a print run on the smallest model that keeps no
// conversation. cca is beside the plugin it loads.
export function probeArgv(pluginRoot: string, account: string): string[] {
  return [`${pluginRoot}/../bin/cca`, account, '-p', '--model', 'haiku', '--no-session-persistence', PROMPT]
}

// The accounts among `candidates` whose readings show a window at its leave
// line, the ones a reset nobody saw would open. One held off after a failure
// is tried again by its own record (failures.ts), not asked here.
export function readingFull(candidates: readonly Candidate[], now: number): string[] {
  return candidates
    .filter(candidate => candidate.blockedUntil === undefined || now >= candidate.blockedUntil)
    .filter(candidate => fullWindow(candidate.reading, now) !== undefined)
    .map(candidate => candidate.name)
}

// Whether `account` was asked less than PROBE_MS ago.
async function askedLately($: EngineInterface, root: string, account: string, now: number): Promise<boolean> {
  const file = probeFile(root, account)
  if (!(await $.fs.exists(file))) return false
  let text: string
  try {
    text = await $.fs.read(file)
  } catch {
    // Rewritten by another session since the check: that session is asking.
    return true
  }
  const at = Number(text.trim())
  return Number.isFinite(at) && now - at < PROBE_MS
}

// Asks each of `accounts` not asked lately, together, and resolves once
// every answer is in with the accounts asked: their readings are then as
// their replies gave them. Never rejects: an account that could not be asked
// keeps its old reading, and the failure is reported.
export async function probe($: EngineInterface, ctx: Context, accounts: readonly string[], now: number): Promise<string[]> {
  const due: string[] = []
  for (const account of accounts) {
    if (!(await askedLately($, ctx.root, account, now))) due.push(account)
  }
  if (due.length === 0) return []
  try {
    const made = await run($, ['mkdir', '-p', `${ctx.root}/probes`])
    if (made.exitCode !== 0) throw new Error(made.stderr.trim())
    // Marked before asking, so that sessions stopped together ask once.
    for (const account of due) await writeAtomic($, probeFile(ctx.root, account), `${now}\n`)
  } catch (error) {
    $.ui.log(`cc-accounts: could not record that ${due.join(', ')} ${due.length === 1 ? 'is' : 'are'} being asked for room (${describeError(error)}).`)
    return []
  }
  await Promise.all(
    due.map(async account => {
      try {
        // A spent account's refusal exits 1, and its reading is saved all the same.
        await $.process.run(probeArgv($.plugin.root, account), { cwd: '/', timeoutMs: PROBE_TIMEOUT_MS })
      } catch (error) {
        $.ui.log(`cc-accounts: could not ask ${account} whether it has room (${describeError(error)}).`)
      }
    }),
  )
  return due
}
