// /account: lists the accounts, reports what is free, sets weights, budgets
// and the default, and moves this conversation to another account.
import type { EngineInterface } from 'claude-code'
import { formatList, parseAsk, USAGE } from './accounts'
import { startOrDefault } from './balance'
import { budgetLines, currentPlan, MAX_BUDGET, parseBudget, projectOf, readBudgetsInForce, SCRATCH_BUDGET, scratchRoot, setBudget } from './budgets'
import { context, defaultName, describeError, emailOf, exitOf, inDesktopApp, writeAtomic, type Context } from './context'
import { wakeParked } from './parking'
import { DEFAULT_WEIGHT, MAX_WEIGHT, normalizeFolder, parseWeight, projectName, readPriorities, setPriority, weightOf } from './priorities'
import { formatReport, gatherReport, totals, totalsLine } from './report'
import { save } from './saved'
import { formatSessions, gatherSessions } from './sessions'
import { readReading } from './survey'
import { afterOf, describeWait, dropSwitch, leadOf, requestSwitch, type SwitchState } from './switching'
import { describeUse } from './usage'

// After /account changes a budget or weight: the sessions it lets go on are woken at once.
async function wakeAfterChange($: EngineInterface, ctx: Context): Promise<string> {
  try {
    await wakeParked($, ctx, await $.clock.now())
    return ''
  } catch (error) {
    return ` Parked sessions could not be checked (${describeError(error)}); each checks again within a minute.`
  }
}

export async function accountCommand($: EngineInterface, args: string, state: SwitchState): Promise<{ text: string }> {
  const ctx = await context($)
  if (ctx === undefined) return { text: 'No accounts set up: run `cca init <name>` in a terminal.' }
  const here = await $.session.root()
  const ask = parseAsk(args)
  if (ask.kind === 'help') return { text: USAGE }

  if (ask.kind === 'list') {
    const now = await $.clock.now()
    const rows = await Promise.all(
      ctx.accounts.map(async account => ({
        account,
        email: await emailOf($, account, ctx.home),
        use: describeUse(await readReading($, ctx.root, account.name), now),
      })),
    )
    const preferred = await defaultName($, ctx)
    const start = await startOrDefault($, ctx, preferred)
    const found = totals(await gatherReport($, ctx, preferred, start, here))
    const list = formatList(rows, ctx.current?.name, preferred, start)
    return { text: `${list}\n${totalsLine(found)} /account usage shows when it comes back and where each project runs.` }
  }

  if (ask.kind === 'report') {
    const preferred = await defaultName($, ctx)
    return { text: formatReport(await gatherReport($, ctx, preferred, await startOrDefault($, ctx, preferred), here)) }
  }

  if (ask.kind === 'sessions') return { text: formatSessions(await gatherSessions($, ctx), await $.session.id()) }

  if (ask.kind === 'priority') {
    const priorities = await readPriorities($, ctx.root)
    if (ask.weight === undefined) {
      const mine = weightOf(priorities, here)
      const set = [...priorities.entries()].sort(([, a], [, b]) => b - a)
      return {
        text: [
          `This project, ${projectName(mine.folder ?? here)}, counts at ${mine.weight}` +
            (mine.folder === undefined ? ', the default.' : ` (set for ${mine.folder}).`),
          ...(set.length === 0 ? [] : ['Weights set:', ...set.map(([folder, weight]) => `  ${String(weight).padEnd(5)}${folder}`)]),
          `Every other project counts at ${DEFAULT_WEIGHT}. A session counts by its weight on the account it runs on, ` +
            'so lighter sessions keep off the accounts heavier ones use and make room for them when one runs low.',
        ].join('\n'),
      }
    }
    const weight = parseWeight(ask.weight)
    if (weight === undefined) return { text: `A weight is a number above 0 and at most ${MAX_WEIGHT}, such as 3 or 0.5.` }
    const folder = ask.folder === undefined ? here : normalizeFolder(ask.folder, ctx.home)
    if (folder === undefined) return { text: 'Name the folder as a full path, or ~/ and the rest of it.' }
    await setPriority($, ctx.root, folder, weight)
    const woken = await wakeAfterChange($, ctx)
    return {
      text: (weight === DEFAULT_WEIGHT
        ? `${projectName(folder)} (${folder}) counts at the default, ${DEFAULT_WEIGHT}, again.`
        : `${projectName(folder)} (${folder}) now counts at ${weight}, and so do the folders inside it that have no weight of their own.`) + woken,
    }
  }

  if (ask.kind === 'budget') {
    if (ask.points === undefined) {
      const budgets = await readBudgetsInForce($, ctx)
      if (budgets.size === 0) {
        return { text: 'No budgets set: every project may spend what the accounts have. Set one with /account budget <points a day> [folder].' }
      }
      const now = await $.clock.now()
      const project = projectOf(budgets, await readPriorities($, ctx.root), here)
      return { text: budgetLines(await currentPlan($, ctx, now), project, now).join('\n') }
    }
    const points = ask.points === '0' ? 0 : parseBudget(ask.points)
    if (points === undefined) return { text: `A budget is a number of points a day above 0 and at most ${MAX_BUDGET}, such as 35; 0 removes it.` }
    const folder = ask.folder === undefined ? here : normalizeFolder(ask.folder, ctx.home)
    if (folder === undefined) return { text: 'Name the folder as a full path, or ~/ and the rest of it.' }
    await setBudget($, ctx.root, folder, points)
    const woken = await wakeAfterChange($, ctx)
    return {
      text: (points === 0
        ? folder === scratchRoot(ctx.home)
          ? `Sessions opened without a folder (${folder}) share the default, ${SCRATCH_BUDGET} points a day, again while any budget is set.`
          : `${projectName(folder)} (${folder}) has no budget of its own: it shares what is left after the budgets set.`
        : `${projectName(folder)} (${folder}) may spend ${points} points a day, and so may the folders inside it that have no budget of their own. ` +
          'Projects with no budget share what the accounts supply beyond the budgets set, by their weights.') + woken,
    }
  }

  const target = ctx.accounts.find(account => account.name === ask.name)
  if (target === undefined) {
    return { text: `No account named ${ask.name}. Accounts: ${ctx.accounts.map(a => a.name).join(', ')}.` }
  }

  if (ask.kind === 'default') {
    await writeAtomic($, `${ctx.root}/default`, `${target.name}\n`)
    const start = await startOrDefault($, ctx, target.name)
    return {
      text: start === target.name
        ? `New sessions start on ${target.name}.`
        : `${target.name} is the default; new sessions start on ${start} while it is low on room or ${start}'s week with room resets sooner.`,
    }
  }

  if (state.ending) return { text: 'This session is already switching accounts.' }
  const sessionId = await $.session.id()
  const current = ctx.current?.name
  if (target.name === current) {
    if (state.pending === undefined) return { text: `This session already runs on ${target.name}.` }
    const dropped = state.pending.target
    await dropSwitch($, state, ctx)
    return { text: `Cancelled the switch to ${dropped}: this session stays on ${target.name}.` }
  }
  const signIn = (await emailOf($, target, ctx.home)) === undefined
    ? ` ${target.name} is not signed in yet: sign in with /login when it opens.`
    : ''

  const exit = await exitOf($, sessionId)
  // The desktop app signs the session in itself, so reopening it there keeps
  // it on the app's account; only cca can open it on another. Nothing is
  // recorded: the session goes on running, and counting, where it is.
  if (exit === undefined && (await inDesktopApp($))) {
    return {
      text:
        `The Claude desktop app runs this session on the account the app is signed in to, ${current ?? 'which cca does not hold'}, ` +
        `and reopening it there keeps it on ${current ?? 'that account'}. To go on with it on ${target.name}, close it here and ` +
        `reopen it in VS Code, or run \`cca ${target.name} --resume ${sessionId}\` in a terminal.${signIn}`,
    }
  }
  const asked = await requestSwitch($, state, ctx, exit, { target: target.name, force: ask.force, by: 'person' })
  await save($, state)
  // Started without cca: the process cannot change its own login, so the
  // choice waits for the conversation's next open.
  if (asked.kind === 'recorded') {
    return {
      text:
        `This conversation opens on ${target.name} from now on.${signIn}\n` +
        `Terminal: exit, then run \`claude --resume ${sessionId}\`. VS Code: close this tab and reopen the conversation.`,
    }
  }
  if (asked.kind === 'started') {
    const { stopping } = asked
    const stopped = stopping.turn || stopping.tasks.length > 0 ? `, stopping ${describeWait(stopping)}` : ''
    return { text: `${leadOf(asked.exit, target.name)}${stopped}: ${afterOf(asked.exit, 'it')}${signIn}` }
  }
  const count = asked.wait.tasks.length + (asked.wait.turn ? 1 : 0)
  $.ui.status(`account ${current ?? '(unknown)'}, switching to ${target.name}`)
  const stay = current === undefined ? '' : ` To stay on ${current}, type /account ${current}.`
  return {
    text:
      `Switch to ${target.name} queued: waiting for ${describeWait(asked.wait)} to end. ` +
      `Then ${afterOf(asked.exit, target.name)}${signIn}\n` +
      `To switch now and stop ${count === 1 ? 'it' : 'them'}, type /account ${target.name} now.${stay}`,
  }
}
