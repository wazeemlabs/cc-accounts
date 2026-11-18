// What a move keeps of the session as it runs: its model and its effort. A
// new process starts on the model and effort Claude Code is configured with,
// not the ones the session ran on, so a model picked with /model (the VS
// Code panel then replayed its own older pick) and an effort set for the
// session alone were lost at every move (2026-11-14: a session on Fable 5.2
// came back on Opus 5.5). Before it ends the process, the plugin writes them
// beside the switch file, one `<name> <value>` line each; cca and cca-stream
// start the new process with them (cca-keep-args, kept_options).
import type { EngineInterface } from 'claude-code'
import { context, describeError, runOnTranscript, writeAtomic } from './context'

// The levels `claude --effort` takes (2.1.325).
export const EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
// The query sources of main-loop requests: the VS Code panel's (stream-json)
// and a terminal's. Subagents, titles and compaction record others.
const MAIN_SOURCES: ReadonlySet<string> = new Set(['sdk', 'repl_main_thread'])
// A model id or alias as Claude Code takes it: `claude-fable-5-2[1m]`, `opus`.
const MODEL = /^[A-Za-z0-9._:/[\]-]+$/

export type Kept = { model: string | undefined; effort: string | undefined }

export function keptFile(switchFile: string): string {
  return `${switchFile}.keep`
}

export function formatKept(kept: Kept): string {
  return `${kept.model === undefined ? '' : `model ${kept.model}\n`}${kept.effort === undefined ? '' : `effort ${kept.effort}\n`}`
}

// The effort of the main-loop request in `rows`, the transcript's api-request
// rows (the last one counts), when it names a level --effort takes.
export function effortIn(rows: string): string | undefined {
  for (const line of rows.split('\n').reverse()) {
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      // A row cut by the read, or a blank line: not the request.
      continue
    }
    if (typeof row !== 'object' || row === null) continue
    const { type, querySource, params } = row as { type?: unknown; querySource?: unknown; params?: { output_config?: { effort?: unknown } } }
    if (type !== 'api-request' || typeof querySource !== 'string' || !MAIN_SOURCES.has(querySource)) continue
    const effort = params?.output_config?.effort
    return typeof effort === 'string' && EFFORTS.has(effort) ? effort : undefined
  }
  return undefined
}

// The model the session runs on, and the effort of its last main-loop
// request. What cannot be read is left out, reported, and the new process
// starts with Claude Code's own setting for it.
export async function keptNow($: EngineInterface): Promise<Kept> {
  let model: string | undefined
  try {
    const value: unknown = await $.session.model()
    model = typeof value === 'string' && MODEL.test(value) ? value : undefined
    if (model === undefined) $.ui.log(`cc-accounts: this session's model (${JSON.stringify(value)}) is not one to pass on; the move keeps Claude Code's setting.`)
  } catch (error) {
    $.ui.log(`cc-accounts: could not read this session's model (${describeError(error)}); the move keeps Claude Code's setting.`)
  }
  const ctx = await context($)
  if (ctx === undefined) return { model, effort: undefined }
  const { exitCode, stdout, stderr } = await runOnTranscript(
    $,
    ctx.shared,
    await $.session.id(),
    `grep -h '"type":"api-request"' "$f" | grep -E '"querySource":"(sdk|repl_main_thread)"' | tail -n 1`,
  )
  if (exitCode !== 0) {
    $.ui.log(`cc-accounts: could not read this session's effort (${stderr.trim()}); the move keeps Claude Code's setting.`)
    return { model, effort: undefined }
  }
  return { model, effort: effortIn(stdout) }
}

// Writes what the move keeps beside `switchFile`, for cca or cca-stream to read
// with the switch request. Never rejects: a move that cannot keep them still
// moves, on Claude Code's own settings, and says so.
export async function writeKept($: EngineInterface, switchFile: string): Promise<void> {
  try {
    await writeAtomic($, keptFile(switchFile), formatKept(await keptNow($)))
  } catch (error) {
    $.ui.log(`cc-accounts: could not keep this session's model and effort for the move (${describeError(error)}).`)
  }
}
