import type { Register } from 'claude-code'
import { formatList, parseAsk, USAGE } from './accounts'
import { taskStarted, turnMark } from './background'
import { balance, noteMeasure, readReading } from './balance'
import { context, defaultName, describeError, emailOf, exitOf, record } from './context'
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
      argumentHint: '[name [now] | default <name>]',
    })
    const ctx = await context($)
    state.root = ctx?.root
    state.interactive = e.isInteractive
    if (ctx?.current !== undefined) {
      $.ui.status(`account ${ctx.current.name}`)
      await record($, ctx, await $.session.id(), ctx.current.name)
    }
    return result
  })

  // A main-loop turn in flight, marked in the record file so that its end
  // tells whether its Stop hook ran.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      state.turns += 1
      if (state.root !== undefined) await $.fs.write(recordFile(state.root, await $.session.id()), turnMark(e.turnId))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    state.turns = Math.max(0, state.turns - 1)
    await readRecord($, state)
    try {
      await balance($, state, e.reason === 'error')
    } catch (error) {
      // Reported, and the session stays where it is: the next turn's end checks again.
      $.ui.log(`cc-accounts: could not check this account's usage (${describeError(error)}).`)
    }
    if (state.pending !== undefined) await $.clock.after(0, () => carryOut($, state))
    return result
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
    if (ask.kind === 'usage') return { text: USAGE }

    if (ask.kind === 'list') {
      const now = await $.clock.now()
      const rows = await Promise.all(
        ctx.accounts.map(async account => ({
          account,
          email: await emailOf($, account, ctx.home),
          use: describeUse(await readReading($, ctx.root, account.name), now),
        })),
      )
      return { text: formatList(rows, ctx.current?.name, await defaultName($, ctx)) }
    }

    const target = ctx.accounts.find(account => account.name === ask.name)
    if (target === undefined) {
      return { text: `No account named ${ask.name}. Accounts: ${ctx.accounts.map(a => a.name).join(', ')}.` }
    }

    if (ask.kind === 'default') {
      await $.fs.write(`${ctx.root}/default`, `${target.name}\n`)
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

    const asked = await requestSwitch($, state, ctx, await exitOf($, sessionId), { target: target.name, force: ask.force })
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
  })
}
