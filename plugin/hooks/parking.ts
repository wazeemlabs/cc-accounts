// Parking and waking. A session whose project is over its allowance is
// parked (register.ts): its tool calls are refused and the model is told to
// stop, so it goes idle, and nothing of its own would start it again. So a
// session refused leaves a record, parked/<session id> holding the folder it
// works in, and is woken once that folder's project is within its allowance
// again (the allowance caught up, the UTC day turned, or a budget or weight
// changed, by /account or in the file). The check runs every WAKE_MS in the
// parked session itself, at every main-loop turn end of any session, and at
// once after /account budget or priority changes something; the last two
// reach a session whose plugin was reloaded, which loses its timer. The waker
// takes the record by removing it, which only one remover can do, so a
// session is woken once: by $.prompt.submit when it is the waker, else by
// $.session.send. The record of a session that has ended is removed.
import type { EngineInterface } from 'claude-code'
import { currentPlan, over, readBudgetsInForce, type Plan, type ProjectBudget } from './budgets'
import { describeError, run, writeAtomic, type Context } from './context'
import { projectName, readPriorities } from './priorities'
import { runningSessions } from './survey'

export const WAKE_MS = 60_000

export type Overrun = { project: ProjectBudget; plan: Plan }

// The project over its allowance now that a session working in a folder
// belongs to, as a lookup by folder; nothing is over when budgets are off
// (CCA_BUDGET=off) or no budget is set, since with none set every project's
// allowance is the whole supply shared, which parks only a project that has
// outspent the accounts.
export async function overrunsNow($: EngineInterface, ctx: Context, now: number): Promise<(cwd: string) => Overrun | undefined> {
  if ((await $.env.get('CCA_BUDGET')) === 'off') return () => undefined
  const budgets = await readBudgetsInForce($, ctx)
  if (budgets.size === 0) return () => undefined
  const found = await currentPlan($, ctx, now)
  const priorities = await readPriorities($, ctx.root)
  return cwd => {
    const project = over(found, budgets, priorities, cwd)
    return project === undefined ? undefined : { project, plan: found }
  }
}

export async function parkedNow($: EngineInterface, ctx: Context, cwd: string, now: number): Promise<Overrun | undefined> {
  return (await overrunsNow($, ctx, now))(cwd)
}

export function parkedFile(root: string, sessionId: string): string {
  return `${root}/parked/${sessionId}`
}

// What a woken session is told: a turn of its own, so it says what to do.
export function wakeText(folder: string): string {
  return `cc-accounts: ${projectName(folder)} is within its budget again, so this session is no longer parked. ` +
    'Carry on with the work you were doing when its tool calls were refused.'
}

export async function noteRefused($: EngineInterface, ctx: Context, sessionId: string, folder: string): Promise<void> {
  await writeAtomic($, parkedFile(ctx.root, sessionId), `${JSON.stringify({ folder })}\n`)
}

// The session went on by itself: there is nothing to wake.
export async function forgetRefused($: EngineInterface, ctx: Context, sessionId: string): Promise<void> {
  const { exitCode, stderr } = await run($, ['rm', '-f', parkedFile(ctx.root, sessionId)])
  if (exitCode !== 0) throw new Error(`could not remove ${parkedFile(ctx.root, sessionId)}: ${stderr.trim()}`)
}

function folderOf(text: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'object' && value !== null && 'folder' in value && typeof value.folder === 'string' && value.folder.startsWith('/')) {
      return value.folder
    }
  } catch {
    // Not JSON: not a record, which the caller reports.
  }
  return undefined
}

// Whether this caller removed the record: one remover alone succeeds.
async function take($: EngineInterface, file: string): Promise<boolean> {
  return (await run($, ['rm', file])).exitCode === 0
}

// Wakes every parked session whose project is within its allowance now.
export async function wakeParked($: EngineInterface, ctx: Context, now: number): Promise<void> {
  const dir = `${ctx.root}/parked`
  if (!(await $.fs.exists(dir))) return
  const names = (await $.fs.list(dir)).filter(entry => entry.kind === 'file' && !entry.name.endsWith('.tmp')).map(entry => entry.name)
  if (names.length === 0) return
  const me = await $.session.id()
  const running = new Set((await runningSessions($, ctx)).map(session => session.sessionId))
  const overrun = await overrunsNow($, ctx, now)
  for (const sessionId of names) {
    const file = parkedFile(ctx.root, sessionId)
    let text: string
    try {
      text = await $.fs.read(file)
    } catch {
      // Taken by another waker since the listing.
      continue
    }
    if (sessionId !== me && !running.has(sessionId)) {
      await take($, file)
      continue
    }
    const folder = folderOf(text)
    if (folder === undefined) {
      if (await take($, file)) $.ui.log(`cc-accounts: ${file} is not a parked session's record; it was removed.`)
      continue
    }
    if (overrun(folder) !== undefined || !(await take($, file))) continue
    const message = wakeText(folder)
    if (sessionId === me) {
      // A turn of its own once this session is idle, submitted from a timer:
      // the engine refuses a submit from the hook of an event the turn waits
      // on, such as /account's command.run.
      $.clock.after(0, () => {
        $.prompt.submit({ text: message }).catch((error: unknown) => {
          $.ui.log(`cc-accounts: could not tell this session to carry on (${describeError(error)}); write to it to go on.`)
        })
      })
      continue
    }
    const sent = await $.session.send({ to: { sessionId }, text: message })
    if (sent.isDelivered) {
      $.ui.log(`cc-accounts: woke session ${sessionId}: ${projectName(folder)} is within its budget again.`, { to: 'debug' })
    } else {
      await writeAtomic($, file, text)
      $.ui.log(`cc-accounts: could not wake session ${sessionId} (${sent.reason}); the next check tries again.`, { to: 'debug' })
    }
  }
}
