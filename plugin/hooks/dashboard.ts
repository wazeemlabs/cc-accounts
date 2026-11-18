// The dashboard pane's data (pane.tsx draws it): every account's use and
// every running session, read as /account usage and /account sessions read
// them, and kept in $.state so the pane redraws when a refresh writes it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import { startOrDefault } from './balance'
import { busy } from './close'
import { defaultName, describeError, type Context } from './context'
import { gatherReport, resetIn, type ReportInput } from './report'
import { gatherSessions, span, LONG_IDLE_MS, type SessionRow } from './sessions'
import { percentNow, windowAtLimit, windowName } from './usage'

import type { CcAccountsDashAccount, CcAccountsDashboard, CcAccountsDashSession } from '../types'

export const PANE = 'cc-accounts'
export const TITLE = 'Accounts and sessions'

const EMPTY: CcAccountsDashboard = { accounts: [], sessions: [], confirm: null, note: '' }

// The tag changes with the picture's fields: a value an earlier version
// stored, which outlives a reload, is read as empty.
const board = atom({ plugin: 'cc-accounts', key: 'dashboard' } as const, EMPTY, { shape: 'dashboard-1' })

// Every write of the picture: the pane is asked to draw again too, so it
// follows a write wherever its read of the picture did not subscribe it.
async function write($: EngineInterface, change: (old: CcAccountsDashboard) => CcAccountsDashboard): Promise<void> {
  await update($, board, change)
  $.ui.invalidate('ui.render')
}

// The picture as the pane draws it: a read while drawing draws the pane
// again when a refresh or a press writes it.
export async function readBoard($: EngineInterface): Promise<CcAccountsDashboard> {
  return read($, board)
}

// Which session's Close waits for a second press; null for none.
export async function setConfirm($: EngineInterface, confirm: string | null): Promise<void> {
  await write($, old => ({ ...old, confirm, note: confirm === null ? old.note : '' }))
}

export function dashAccounts(input: ReportInput): CcAccountsDashAccount[] {
  return input.accounts.map(({ state }) => {
    const { reading } = state
    const name = state.account.name
    const spent = reading === undefined ? undefined : windowAtLimit(reading, input.now)
    const used = (kind: string) => (reading === undefined ? null : Math.round(percentNow(reading, kind, input.now)))
    return {
      name,
      isSignedIn: state.email !== undefined,
      fiveUsed: used('five_hour'),
      fiveReset: reading === undefined ? '-' : resetIn(reading, 'five_hour', input.now),
      weekUsed: used('seven_day'),
      weekReset: reading === undefined ? '-' : resetIn(reading, 'seven_day', input.now),
      spent: reading === undefined || spent === undefined
        ? null
        : `spent until its ${windowName(spent)} window resets in ${resetIn(reading, spent, input.now)}`,
      sessions: input.live.filter(session => session.account === name).length,
      isCurrent: name === input.current,
      isStart: name === input.startName,
    }
  })
}

export function dashSessions(rows: readonly SessionRow[], here: string): CcAccountsDashSession[] {
  return rows.map(row => ({
    id: row.sessionId,
    name: row.name || row.sessionId.slice(0, 8),
    where: row.where,
    state: (row.idleMs === undefined ? 'working' : `idle ${span(row.idleMs)}`) + (row.tasks === 0 ? '' : `, ${row.tasks} in background`),
    busy: busy(row) ?? null,
    kb: row.ownKb + row.helperKb,
    isStale: row.sessionId !== here && (row.idleMs ?? 0) >= LONG_IDLE_MS && row.tasks === 0,
    isHere: row.sessionId === here,
  }))
}

// Reads the machine again and writes the picture; what is being confirmed
// and the last answer stay unless `change` replaces them.
export async function refresh(
  $: EngineInterface,
  ctx: Context,
  change: Partial<Pick<CcAccountsDashboard, 'confirm' | 'note'>> = {},
): Promise<void> {
  const preferred = await defaultName($, ctx)
  const report = await gatherReport($, ctx, preferred, await startOrDefault($, ctx, preferred), await $.session.root())
  const sessions = dashSessions(await gatherSessions($, ctx), await $.session.id())
  await write($, old => ({ ...old, ...change, accounts: dashAccounts(report), sessions }))
}

// A refresh nobody waits for, as a timer or a turn's end starts: a failure
// is said once in the pane's note.
export async function refreshQuietly($: EngineInterface, ctx: Context): Promise<void> {
  try {
    await refresh($, ctx)
  } catch (error) {
    await write($, old => ({ ...old, note: `Could not read the accounts and sessions (${describeError(error)}).` }))
  }
}

export async function openDashboard($: EngineInterface, ctx: Context): Promise<string> {
  await refresh($, ctx, { confirm: null, note: '' })
  const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE })
  return isPlaced
    ? 'The accounts and sessions pane is open.'
    : 'This window shows no panes: /account usage and /account sessions list the same, and /account close closes a session.'
}
