import type { EngineInterface, Register, Timer } from 'claude-code'
import { taskStarted, turnMark } from './background'
import { accountCommand } from './command'
import { balance, noteMeasure, showStatus, startOrDefault } from './balance'
import { context, describeError, exitOf, record, type Context } from './context'
import { projectName } from './priorities'
import { forgetRefused, noteRefused, parkedFile, parkedNow, WAKE_MS, wakeParked } from './parking'
import { registerPane } from './pane'
import { prune } from './prune'
import { restore, save } from './saved'
import { carryOut, newState, readRecord, recordFile } from './switching'
import { parkedText, type ProjectBudget } from './budgets'
import { recordCalibration, recordSpend, weightedTokens } from './spend'
import { ownReading } from './survey'

// This session's project over its day's allowance, decided at each
// main-loop turn's end and checked again at a parked session's tool calls,
// so a turn in flight is never cut. `refused`: a tool call was refused, so
// work stopped, and a record and a check every WAKE_MS (`timer`) wake the
// session once the project is within its allowance (parking.ts); a call
// that goes through, or a new turn, means it went on and needs no wake.
type Parked = { project: ProjectBudget | undefined; refused: boolean; timer: Timer | undefined }

async function park(
  $: EngineInterface,
  ctx: Context,
  parked: Parked,
  now: number,
): Promise<Awaited<ReturnType<typeof parkedNow>>> {
  const found = await parkedNow($, ctx, await $.session.root(), now)
  const was = parked.project
  parked.project = found?.project
  if (found !== undefined && was === undefined) {
    $.ui.log(parkedText(found.project, found.plan, now))
    $.ui.status(`account ${ctx.current?.name ?? '(unknown)'} · parked: ${projectName(found.project.folder)} over budget`)
  } else if (found === undefined && was !== undefined) {
    $.ui.log(`cc-accounts: ${projectName(was.folder)} is within its budget again; this session goes on.`)
    $.ui.status(`account ${ctx.current?.name ?? '(unknown)'}`)
  }
  return found
}

// The session goes on, woken or by itself: its check stops.
function stopChecking(parked: Parked): void {
  parked.timer?.cancel()
  parked.timer = undefined
  parked.refused = false
}

// A parked session's check, every WAKE_MS: whether its project is within
// its allowance now, then every parked session woken that is, itself too.
async function check($: EngineInterface, parked: Parked): Promise<void> {
  try {
    const ctx = await context($)
    if (ctx === undefined) return
    const now = await $.clock.now()
    if ((await park($, ctx, parked, now)) === undefined) stopChecking(parked)
    await wakeParked($, ctx, now)
  } catch (error) {
    // Reported; the next check tries again.
    $.ui.log(`cc-accounts: could not check whether this session may go on (${describeError(error)}).`)
  }
}

export const register: Register = on => {
  const state = newState()
  registerPane(on, state)
  const parked: Parked = { project: undefined, refused: false, timer: undefined }
  // Whether the prune a main-loop turn's end started for this conversation
  // still runs: it can wait on the machine's lock, and turns ending meanwhile
  // would each leave another child waiting behind it.
  const pruning = { running: false }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'account',
      description: 'Show or switch the Claude account this session runs on',
      argumentHint: '[name [now] | default <name> | usage | priority [<weight> [<folder>]]]',
    })
    const ctx = await context($)
    state.root = ctx?.root
    state.interactive = e.isInteractive
    // A reload of the plugin in this process: what the last load knew stands,
    // a queued switch included, and the conversation stays recorded on its
    // target.
    const reloaded = await restore($, state, await exitOf($, await $.session.id()))
    if (ctx?.current !== undefined) {
      if (state.pending !== undefined) {
        $.ui.status(`account ${ctx.current.name}, moving to ${state.pending.target}`)
        await $.clock.after(0, () => carryOut($, state))
      } else {
        $.ui.status(`account ${ctx.current.name}`)
        await record($, ctx, await $.session.id(), ctx.current.name)
      }
    }
    // A refused session whose minute check a reload cancelled (or a new
    // process on a refused conversation): its check starts again.
    if (ctx !== undefined && parked.timer === undefined && (await $.fs.exists(parkedFile(ctx.root, await $.session.id())))) {
      parked.refused = true
      parked.timer = $.clock.every(WAKE_MS, () => void check($, parked))
    }
    // prune() reports its own failures and never rejects; the session does not
    // wait for it. A reload already pruned at this process's first start: one
    // update reloads every session, and each started a prune of every file.
    if (ctx !== undefined && !reloaded) void prune($, ctx, { all: true })
    return result
  }).catch(async ($, e, next) => {
    $.ui.log(`cc-accounts: could not record this session's account (${describeError(next.error)}).`)
    return next(e)
  })

  // A main-loop turn in flight, marked in the record file so that its end
  // tells whether its Stop hook ran.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      state.turns += 1
      await save($, state)
      if (state.root !== undefined) await $.fs.write(recordFile(state.root, await $.session.id()), turnMark(e.turnId))
      // A person or a wake started it again: nothing is left to wake it for,
      // and a refusal in this turn writes the record again.
      if (parked.refused) {
        stopChecking(parked)
        const ctx = await context($)
        if (ctx !== undefined) await forgetRefused($, ctx, await $.session.id())
      }
    }
    return next(e)
  }).catch(async ($, e, next) => {
    // The turn is still counted once it was; only its mark is missing, so a
    // turn that ends without a Stop hook keeps the work listed before it.
    $.ui.log(`cc-accounts: could not mark this turn's start (${describeError(next.error)}).`)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A subagent's turns cost the account too, and count against the budget.
    if (e.agentId !== undefined) {
      const ctx = await context($)
      // A session on a login cca does not hold spends no account's points.
      if (ctx?.current !== undefined && e.usage !== undefined) {
        await recordSpend($, ctx.root, await $.session.id(), await $.session.root(), await $.clock.now(), weightedTokens(e.usage))
      }
      return result
    }
    state.turns = Math.max(0, state.turns - 1)
    if (e.usage?.model !== undefined) state.answered = e.usage.model
    // A turn that ends while the process is being ended was cut short by the switch.
    if (state.ending) state.cutTurn = true
    await readRecord($, state)
    try {
      await balance($, state, e.reason === 'error')
    } catch (error) {
      // Reported, and the session stays where it is: the next turn's end checks again.
      $.ui.log(`cc-accounts: could not check this account's usage (${describeError(error)}).`)
    }
    const ctx = await context($)
    if (ctx !== undefined) {
      try {
        const now = await $.clock.now()
        // A session on a login cca does not hold spends no account's points:
        // counted, its tokens would have no points beside them in the
        // calibration, and it would be parked as a project with no share.
        if (ctx.current !== undefined) {
          if (e.usage !== undefined) {
            await recordSpend($, ctx.root, await $.session.id(), await $.session.root(), now, weightedTokens(e.usage))
          }
          await park($, ctx, parked, now)
        }
        await wakeParked($, ctx, now)
      } catch (error) {
        // Reported; the turn's cost is uncounted and the session goes on unparked until the next turn's end.
        $.ui.log(`cc-accounts: could not count this turn against its budget (${describeError(error)}).`)
      }
      await startOrDefault($, ctx, undefined)
      // The transcript is pruned once the turn a compaction ran in has ended:
      // prune.py looks for one since its last look, and passes by without.
      if (!pruning.running) {
        const session = await $.session.id()
        pruning.running = true
        // As at the start: prune() reports its own failures and never rejects.
        void prune($, ctx, { session }).then(() => { pruning.running = false })
      }
    }
    await save($, state)
    if (state.pending !== undefined) await $.clock.after(0, () => carryOut($, state))
    return result
  }).catch(async ($, e, next) => {
    $.ui.log(`cc-accounts: could not finish this turn's checks (${describeError(next.error)}).`)
    return next(e)
  })

  // The account's rate-limit windows moved: every session can now see them.
  // The context window's fill moved: the status line shows it.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('rateLimits')) {
      await noteMeasure($, state)
      const ctx = await context($)
      const reading = ctx?.current === undefined ? undefined : await ownReading($, ctx.current.name)
      if (ctx !== undefined && reading !== undefined) await recordCalibration($, ctx.root, reading)
    } else if (e.changed.includes('context')) {
      await showStatus($, state)
    }
    return result
  }).catch(async ($, e, next) => {
    $.ui.log(`cc-accounts: could not save this account's usage (${describeError(next.error)}).`)
    return next(e)
  })

  // Background work started since the last Stop hook, for a turn that ends
  // without one.
  on('tool.call', async ($, e, next) => {
    if (parked.project !== undefined) {
      const ctx = await context($)
      const now = await $.clock.now()
      const found = ctx === undefined ? undefined : await park($, ctx, parked, now)
      if (ctx !== undefined && found !== undefined) {
        if (!parked.refused) {
          parked.refused = true
          await noteRefused($, ctx, await $.session.id(), await $.session.root())
          parked.timer = $.clock.every(WAKE_MS, () => void check($, parked))
        }
        return { deny: parkedText(found.project, found.plan, now) }
      }
      if (ctx !== undefined && parked.refused) {
        stopChecking(parked)
        await forgetRefused($, ctx, await $.session.id())
      }
    }
    const answer = await next(e)
    if (answer.result !== undefined) {
      const task = taskStarted(e.tool, e as unknown as Record<string, unknown>, answer.result)
      if (task !== undefined) {
        state.tasks.set(task.id, task)
        await save($, state)
      }
    }
    return answer
  }).catch(async ($, e, next) => {
    $.ui.log(`cc-accounts: could not note what a ${e.tool} call started (${describeError(next.error)}).`)
    return next(e)
  })

  on('command.run', { command: 'account' }, async ($, e) => accountCommand($, e.args, state))
    .catch(($, _e, next) => ({ text: `cc-accounts: /account could not finish (${describeError(next.error)}).` }))
}
