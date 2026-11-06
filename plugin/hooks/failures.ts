// Why the last main-loop turn failed, and which accounts failed recently.
//
// Claude Code classifies every API error with one word (`rate_limit`,
// `authentication_failed`, `overloaded`, ...: StopFailure's `error`) and
// writes it as the `error` field of the API-error row it appends to the
// transcript, before the turn completes. The StopFailure hook itself runs
// after turn.complete, so the transcript is where the module reads it. That
// word catches what the rate-limit readings miss: a per-model limit (a
// model's weekly cap) and a login the account lost.
//
// An account that failed for a reason of its own is recorded in
// blocked/<account>/<scope>.json, so that no session moves there for a
// while. A lost login, a hold or a billing failure is the whole account's
// (scope `account`). A usage limit the readings do not show is a per-model
// one (a model's weekly cap, its included use spent: the API says
// `model_requires_usage_credits`), so it is recorded for the model family
// that hit it, and sessions on other families still move there.
import type { EngineInterface } from 'claude-code'
import { describeError, run, writeAtomic, type Context } from './context'
import { blockMsOf } from './usage'

// The scope of a failure that is the whole account's.
export const ACCOUNT_SCOPE = 'account'

// Model aliases that name no one family: `best` follows the plan, and
// `opusplan` runs Opus in plan mode and Sonnet otherwise. An unset model
// reads as `default`.
const MIXED_ALIASES: ReadonlySet<string> = new Set(['default', 'best', 'opusplan'])

// The family a model name belongs to, which a per-model limit covers:
// `claude-opus-4-6`, `opus` and `opus[1m]` are `opus`; undefined for a name
// that names no one family.
export function familyOf(model: string): string | undefined {
  const name = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '')
  const id = /^claude-(?:[0-9]+-)*([a-z]+)(?:-|$)/.exec(name)
  if (id !== null) return id[1]
  return /^[a-z]+$/.test(name) && !MIXED_ALIASES.has(name) ? name : undefined
}

// Where a failure is recorded: a usage limit for the family that hit it, when
// it is known; anything else for the whole account.
export function scopeOf(error: string, family: string | undefined): string {
  return error === 'rate_limit' && family !== undefined ? family : ACCOUNT_SCOPE
}

// The family of the model this session runs: its model setting when that
// names one, else that of the model that last answered in this process.
export async function sessionFamily($: EngineInterface, answered: string | undefined): Promise<string | undefined> {
  let setting: unknown
  try {
    setting = (await $.config.list()).find(row => row.key === 'model')?.value
  } catch (error) {
    $.ui.log(`cc-accounts: could not read this session's model setting (${describeError(error)}).`)
  }
  const named = typeof setting === 'string' ? familyOf(setting) : undefined
  return named ?? (answered === undefined ? undefined : familyOf(answered))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The error word of the last assistant row in `tail` (the transcript's last
// lines), or undefined when that row is not an API error.
export function failureIn(tail: string): string | undefined {
  let found: string | undefined
  for (const line of tail.split('\n')) {
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      // A line tail cut short, or tail's file header: not a row to read.
      continue
    }
    if (!isObject(row) || row.type !== 'assistant') continue
    found = row.isApiErrorMessage === true && typeof row.error === 'string' && row.error !== '' ? row.error : undefined
  }
  return found
}

// How much of the transcript's end is read for the error row. The rows
// written after it as a turn ends are short but up to a dozen (2.1.318:
// titles, mode, bridge records, queue entries), and the row before it can
// be megabytes (a screenshot), so the end is read by bytes, not lines; the
// first row, cut by the read, does not parse and is skipped.
const TAIL_BYTES = 1024 * 1024

// The error word that ended this conversation's last turn, from its
// transcript in the shared projects folder (the newest, should a resume from
// another folder have left two); undefined when it shows none or cannot be
// read (the caller then goes by the readings).
export async function turnFailure($: EngineInterface, ctx: Context): Promise<string | undefined> {
  const sessionId = await $.session.id()
  const { exitCode, stdout, stderr, isStdoutTruncated } = await run($, [
    '/bin/sh',
    '-c',
    'f=$(ls -t "$1"/projects/*/"$2".jsonl 2>/dev/null | head -n 1); ' +
      `if [ -z "$f" ]; then echo "no transcript of $2" >&2; exit 1; fi; tail -c ${TAIL_BYTES} "$f"`,
    'sh',
    ctx.shared,
    sessionId,
  ])
  if (exitCode !== 0 || isStdoutTruncated) {
    $.ui.log(`cc-accounts: could not read why the last turn failed (${isStdoutTruncated ? 'the transcript tail was cut' : stderr.trim()}).`)
    return undefined
  }
  return failureIn(stdout)
}

export function blockFile(root: string, account: string, scope: string): string {
  return `${root}/blocked/${account}/${scope}.json`
}

// Records that `account` failed with `error` at `at`, for `scope`.
export async function block(
  $: EngineInterface,
  root: string,
  account: string,
  scope: string,
  error: string,
  at: number,
): Promise<void> {
  await writeAtomic($, blockFile(root, account, scope), `${JSON.stringify({ error, at })}\n`)
}

// Until when the record in `file` keeps sessions off its account.
async function heldUntil($: EngineInterface, file: string, account: string): Promise<number | undefined> {
  if (!(await $.fs.exists(file))) return undefined
  let value: unknown
  try {
    value = JSON.parse(await $.fs.read(file))
  } catch (error) {
    $.ui.log(`cc-accounts: ${file} is not a failure record (${describeError(error)}); ${account} counts as working.`)
    return undefined
  }
  if (!isObject(value) || typeof value.at !== 'number' || typeof value.error !== 'string') return undefined
  return value.at + blockMsOf(value.error)
}

// Until when a session on `family` (undefined: not known) keeps off
// `account`, after a failure of the whole account's or one of that family's.
// Undefined when it has not failed.
export async function blockedUntil(
  $: EngineInterface,
  root: string,
  account: string,
  family: string | undefined,
): Promise<number | undefined> {
  const scopes = family === undefined ? [ACCOUNT_SCOPE] : [ACCOUNT_SCOPE, family]
  const times = await Promise.all(scopes.map(scope => heldUntil($, blockFile(root, account, scope), account)))
  const known = times.filter((at): at is number => at !== undefined)
  return known.length === 0 ? undefined : Math.max(...known)
}

// Every failure record of `account` still in force at `now`: its scope (a
// model family, or `account`) and until when it holds.
export async function holdsOf(
  $: EngineInterface,
  root: string,
  account: string,
  now: number,
): Promise<{ scope: string; until: number }[]> {
  const dir = `${root}/blocked/${account}`
  if (!(await $.fs.exists(dir))) return []
  const holds: { scope: string; until: number }[] = []
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const until = await heldUntil($, `${dir}/${entry.name}`, account)
    if (until !== undefined && until > now) holds.push({ scope: entry.name.slice(0, -'.json'.length), until })
  }
  return holds.sort((a, b) => a.scope.localeCompare(b.scope))
}
