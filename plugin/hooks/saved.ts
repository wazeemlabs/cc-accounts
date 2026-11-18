// What a session's switch state must keep across a hot reload of the plugin.
// CLAUDE_CODE_PLUGIN_DIR_WATCH=1 reloads the plugin in every running session
// once its turn ends, which runs register (a fresh newState()) and
// session.start again in the same process. Without this a queued switch was
// lost and session.start recorded the conversation back on the old account,
// and the background work known from the last Stop hook was forgotten, so the
// next /account switched at once and stopped it (2026-11-15 review).
//
// $.state holds named values for the session's process and keeps them across
// reloads; a new process (a switch's --resume) starts without them. The exit
// is not kept: exitOf reads it from the environment again.
import type { EngineInterface } from 'claude-code'
import { describeError } from './context'
import type { Task } from './background'
import type { Pending, SwitchState } from './switching'
import type { Stop } from './usage'

import type { CcAccountsSwitching } from '../types'

export type SavedSwitch = CcAccountsSwitching

const SWITCHING = { plugin: 'cc-accounts', key: 'switching' } as const

export function snapshot(state: SwitchState): SavedSwitch {
  const pending = state.pending === undefined ? null : { ...state.pending }
  if (pending !== null) delete (pending as Partial<Pending>).exit
  return {
    pending,
    tasks: [...state.tasks.values()],
    turns: state.turns,
    answered: state.answered ?? null,
    stranded: state.stranded ?? null,
    strandedNote: state.strandedNote ?? null,
    browser: state.browser,
  }
}

function isTask(value: unknown): value is Task {
  const task = value as Task
  return typeof task === 'object' && task !== null && typeof task.id === 'string' && typeof task.type === 'string' &&
    typeof task.description === 'string'
}

function isStop(value: unknown): value is Stop | undefined {
  if (value === undefined) return true
  const stop = value as Record<string, unknown>
  return typeof stop === 'object' && stop !== null && (typeof stop.window === 'string' || typeof stop.error === 'string')
}

// The saved state, or undefined when there is none or it is not of this
// version's shape (one an older plugin saved is dropped, not trusted).
export function parseSaved(value: unknown): SavedSwitch | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const saved = value as Record<string, unknown>
  const optional = (field: unknown) => field === null || typeof field === 'string'
  if (!Array.isArray(saved.tasks) || !saved.tasks.every(isTask)) return undefined
  if (typeof saved.turns !== 'number' || !Number.isInteger(saved.turns) || saved.turns < 0) return undefined
  if (!optional(saved.answered) || !optional(saved.stranded) || !optional(saved.strandedNote)) return undefined
  if (saved.browser !== undefined && typeof saved.browser !== 'boolean') return undefined
  const pending = saved.pending as Record<string, unknown> | null
  if (pending !== null) {
    if (typeof pending !== 'object' || typeof pending.target !== 'string' || typeof pending.force !== 'boolean') return undefined
    if (pending.from !== undefined && typeof pending.from !== 'string') return undefined
    if (!isStop(pending.stop)) return undefined
    if (pending.by !== undefined && pending.by !== 'person' && pending.by !== 'balancer') return undefined
  }
  return saved as SavedSwitch
}

// Never rejects: it runs after a tool call has gone through, where an error
// would run the hook's fallback and the call again. A save that fails only
// leaves a later reload to start from what was saved before.
export async function save($: EngineInterface, state: SwitchState): Promise<void> {
  try {
    await $.state.set(SWITCHING, snapshot(state))
  } catch (error) {
    $.ui.log(`cc-accounts: could not save this session's switching state for a reload (${describeError(error)}).`, { to: 'debug' })
  }
}

// Puts what an earlier load of the plugin saved in this process back into
// `state`. False when nothing was saved, as in a new process.
export async function restore($: EngineInterface, state: SwitchState, exitNow: Pending['exit'] | undefined): Promise<boolean> {
  const saved = parseSaved((await $.state.get(SWITCHING)).value)
  if (saved === undefined) return false
  state.tasks = new Map(saved.tasks.map(task => [task.id, task]))
  state.turns = saved.turns
  state.answered = saved.answered ?? undefined
  state.stranded = saved.stranded ?? undefined
  state.strandedNote = saved.strandedNote ?? undefined
  state.browser = saved.browser ?? false
  // A queued switch goes on only where this process can still be ended for it.
  // One saved with no word of who asked is a person's, never decided again.
  state.pending = saved.pending !== null && exitNow !== undefined
    ? { ...saved.pending, by: saved.pending.by ?? 'person', exit: exitNow }
    : undefined
  return true
}
