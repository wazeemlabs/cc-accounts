import type { Register } from 'claude-code'
import { formatList, parseAsk, USAGE } from './accounts'
import { taskStarted, turnMark } from './background'
import { balance, noteMeasure } from './balance'
import { context, defaultName, describeError, emailOf, exitOf, record, writeAtomic } from './context'
import {
  DEFAULT_WEIGHT,
  MAX_WEIGHT,
  normalizeFolder,
  parseWeight,
  projectName,
  readPriorities,
  setPriority,
  weightOf,
} from './priorities'
import { formatReport, gatherReport, totals, totalsLine } from './report'
import { readReading } from './survey'
import {
  afterOf,
  carryOut,
  describeWait,
  leadOf,
  newState,
  readRecord,
  recordFile,
  requestSwitch,
} from './switching'
import { describeUse } from './usage'

export const register: Register = on => {
  const state = newState()

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
    state.cwd = e.cwd
    if (ctx?.current !== undefined) {
      $.ui.status(`account ${ctx.current.name}`)
      await record($, ctx, await $.session.id(), ctx.current.name)
    }
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
      if (state.root !== undefined) await $.fs.write(recordFile(state.root, await $.session.id()), turnMark(e.turnId))
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
    if (e.agentId !== undefined) return result
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
    if (state.pending !== undefined) await $.clock.after(0, () => carryOut($, state))
    return result
  }).catch(async ($, e, next) => {
    $.ui.log(`cc-accounts: could not finish this turn's checks (${describeError(next.error)}).`)
    return next(e)
  })

  // The account's rate-limit windows moved: every session can now see them.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('rateLimits')) await noteMeasure($, state)
    return result
  }).catch(async ($, e, next) => {
    $.ui.log(`cc-accounts: could not save this account's usage (${describeError(next.error)}).`)
    return next(e)
  })

  // Background work started since the last Stop hook, for a turn that ends
  // without one.
  on('tool.call', async ($, e, next) => {
    const answer = await next(e)
    if (answer.result !== undefined) {
      const task = taskStarted(e.tool, e as unknown as Record<string, unknown>, answer.result)
      if (task !== undefined) state.tasks.set(task.id, task)
    }
    return answer
  }).catch(async ($, e, next) => {
    $.ui.log(`cc-accounts: could not note what a ${e.tool} call started (${describeError(next.error)}).`)
    return next(e)
  })

  on('command.run', { command: 'account' }, async ($, e) => {
    const ctx = await context($)
    if (ctx === undefined) return { text: 'No accounts set up: run `cca init <name>` in a terminal.' }
    const ask = parseAsk(e.args)
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
      const found = totals(await gatherReport($, ctx, await defaultName($, ctx)))
      const list = formatList(rows, ctx.current?.name, await defaultName($, ctx))
      return { text: `${list}\n${totalsLine(found)} /account usage shows when it comes back and where each project runs.` }
    }

    if (ask.kind === 'report') return { text: formatReport(await gatherReport($, ctx, await defaultName($, ctx))) }

    if (ask.kind === 'priority') {
      const priorities = await readPriorities($, ctx.root)
      if (ask.weight === undefined) {
        const mine = state.cwd === undefined ? undefined : weightOf(priorities, state.cwd)
        const set = [...priorities.entries()].sort(([, a], [, b]) => b - a)
        return {
          text: [
            mine === undefined || state.cwd === undefined
              ? 'This session started in no known folder.'
              : `This project, ${projectName(mine.folder ?? state.cwd)}, counts at ${mine.weight}` +
                (mine.folder === undefined ? ', the default.' : ` (set for ${mine.folder}).`),
            ...(set.length === 0 ? [] : ['Weights set:', ...set.map(([folder, weight]) => `  ${String(weight).padEnd(5)}${folder}`)]),
            `Every other project counts at ${DEFAULT_WEIGHT}. A session counts by its weight on the account it runs on, ` +
              'so lighter sessions keep off the accounts heavier ones use and make room for them when one runs low.',
          ].join('\n'),
        }
      }
      const weight = parseWeight(ask.weight)
      if (weight === undefined) return { text: `A weight is a number above 0 and at most ${MAX_WEIGHT}, such as 3 or 0.5.` }
      const folder = ask.folder === undefined ? state.cwd : normalizeFolder(ask.folder, ctx.home)
      if (folder === undefined) return { text: 'Name the folder as a full path, or ~/ and the rest of it.' }
      await setPriority($, ctx.root, folder, weight)
      return {
        text: weight === DEFAULT_WEIGHT
          ? `${projectName(folder)} (${folder}) counts at the default, ${DEFAULT_WEIGHT}, again.`
          : `${projectName(folder)} (${folder}) now counts at ${weight}, and so do the folders inside it that have no weight of their own.`,
      }
    }

    const target = ctx.accounts.find(account => account.name === ask.name)
    if (target === undefined) {
      return { text: `No account named ${ask.name}. Accounts: ${ctx.accounts.map(a => a.name).join(', ')}.` }
    }

    if (ask.kind === 'default') {
      await writeAtomic($, `${ctx.root}/default`, `${target.name}\n`)
      return { text: `New sessions start on ${target.name}.` }
    }

    if (state.ending) return { text: 'This session is already switching accounts.' }
    const sessionId = await $.session.id()
    const current = ctx.current?.name
    if (target.name === current) {
      if (state.pending === undefined) return { text: `This session already runs on ${target.name}.` }
      const dropped = state.pending.target
      state.pending = undefined
      await record($, ctx, sessionId, target.name)
      $.ui.status(`account ${target.name}`)
      return { text: `Cancelled the switch to ${dropped}: this session stays on ${target.name}.` }
    }
    const signIn = (await emailOf($, target, ctx.home)) === undefined
      ? ` ${target.name} is not signed in yet: sign in with /login when it opens.`
      : ''

    const exit = await exitOf($, sessionId)
    const asked = await requestSwitch($, state, ctx, exit, { target: target.name, force: ask.force })
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
  }).catch(($, _e, next) => ({ text: `cc-accounts: /account could not finish (${describeError(next.error)}).` }))
}
