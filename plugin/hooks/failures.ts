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
// blocked/<account>.json, so that no session moves there for a while.
import type { EngineInterface } from 'claude-code'
import { describeError, writeAtomic, type Context } from './context'

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

// Rows after the API-error one (system notes) are few and short; the error
// row itself is short.
const TAIL_LINES = 6

// The error word that ended this conversation's last turn, from its
// transcript in the shared projects folder; undefined when it shows none or
// cannot be read (the caller then goes by the readings).
export async function turnFailure($: EngineInterface, ctx: Context): Promise<string | undefined> {
  const sessionId = await $.session.id()
  const { exitCode, stdout, stderr, isStdoutTruncated } = await $.process.run([
    '/bin/sh',
    '-c',
    `tail -q -n ${TAIL_LINES} "$1"/projects/*/"$2".jsonl`,
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

export function blockFile(root: string, account: string): string {
  return `${root}/blocked/${account}.json`
}

// Records that `account` failed with `error` at `at`.
export async function block($: EngineInterface, root: string, account: string, error: string, at: number): Promise<void> {
  await writeAtomic($, blockFile(root, account), `${JSON.stringify({ error, at })}\n`)
}

// When `account` last failed for a reason of its own, or undefined.
export async function blockedAt($: EngineInterface, root: string, account: string): Promise<number | undefined> {
  const file = blockFile(root, account)
  if (!(await $.fs.exists(file))) return undefined
  let value: unknown
  try {
    value = JSON.parse(await $.fs.read(file))
  } catch (error) {
    $.ui.log(`cc-accounts: ${file} is not a failure record (${describeError(error)}); ${account} counts as working.`)
    return undefined
  }
  return isObject(value) && typeof value.at === 'number' ? value.at : undefined
}
