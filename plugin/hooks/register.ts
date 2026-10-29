import type { EngineInterface, Register } from 'claude-code'
import {
  configFileOf,
  currentAccount,
  emailIn,
  formatList,
  parseAsk,
  parseTable,
  USAGE,
  type Account,
} from './accounts'
import { taskStarted, turnMark } from './background'
import {
  afterOf,
  carryOut,
  describeWait,
  leadOf,
  newState,
  readRecord,
  recordFile,
  waitingFor,
  type Exit,
} from './switching'

type Context = {
  home: string
  root: string
  accounts: Account[]
  current: Account | undefined
}

async function context($: EngineInterface): Promise<Context | undefined> {
  const home = await $.env.get('HOME')
  if (home === undefined) return undefined
  // cca names its state dir; a session started without cca has the default.
  const root = (await $.env.get('CCA_ROOT')) || `${home}/.claude-shared/accounts`
  const table = `${root}/accounts.tsv`
  if (!(await $.fs.exists(table))) return undefined
  const accounts = parseTable(await $.fs.read(table))
  const current = currentAccount(
    accounts,
    await $.env.get('CLAUDE_ACCOUNT'),
    await $.env.get('CLAUDE_CONFIG_DIR'),
    home,
  )
  return { home, root, accounts, current }
}

async function emailOf($: EngineInterface, account: Account, home: string): Promise<string | undefined> {
  const file = configFileOf(account, home)
  return (await $.fs.exists(file)) ? emailIn(await $.fs.read(file)) : undefined
}

async function defaultName($: EngineInterface, ctx: Context): Promise<string | undefined> {
  const file = `${ctx.root}/default`
  if (!(await $.fs.exists(file))) return ctx.accounts[0]?.name
  return (await $.fs.read(file)).trim() || ctx.accounts[0]?.name
}

// This process's id and its parent's, as decimal strings. $.process.run starts
// sh directly, so sh's parent is this process.
async function processIds($: EngineInterface): Promise<{ self: string; parent: string } | undefined> {
  const { exitCode, stdout } = await $.process.run(['/bin/sh', '-c', 'echo $PPID; ps -o ppid= -p $PPID'])
  const [self, parent] = stdout.split('\n').map(line => line.trim())
  return exitCode === 0 && self && parent ? { self, parent } : undefined
}

// cca resumes a conversation on the account it last ran on.
async function record($: EngineInterface, ctx: Context, sessionId: string, name: string): Promise<void> {
  await $.fs.write(`${ctx.root}/by-session/${sessionId}`, `${name}\n`)
}

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
    if (state.pending !== undefined) await $.clock.after(0, () => carryOut($, state))
    return result
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
    $.ui.log(`cc-accounts: could not note what a ${e.tool} call started (${String(next.error)}).`)
    return next(e)
  })

  on('command.run', { command: 'account' }, async ($, e) => {
    const ctx = await context($)
    if (ctx === undefined) return { text: 'No accounts set up: run `cca init <name>` in a terminal.' }
    const ask = parseAsk(e.args)
    if (ask.kind === 'usage') return { text: USAGE }

    if (ask.kind === 'list') {
      const rows = await Promise.all(
        ctx.accounts.map(async account => ({ account, email: await emailOf($, account, ctx.home) })),
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
    await record($, ctx, sessionId, target.name)
    const signIn = (await emailOf($, target, ctx.home)) === undefined
      ? ` ${target.name} is not signed in yet: sign in with /login when it opens.`
      : ''

    // How cca started this process, and whether it is this process (a claude
    // started inside a session inherits the variables of the session's own).
    const mode = await $.env.get('CCA_MODE')
    const ccaPid = await $.env.get('CCA_PID')
    const ids = mode === undefined ? undefined : await processIds($)
    const switchFile = await $.env.get('CLAUDE_ACCOUNT_SWITCH_FILE')
    let exit: Exit | undefined
    if (mode === 'terminal' && switchFile && ids?.parent === ccaPid) exit = { kind: 'terminal', switchFile, sessionId }
    if (mode === 'stream' && ids !== undefined && ids.self === ccaPid) exit = { kind: 'stream', pid: ids.self }

    // Started without cca: the process cannot change its own login, so the
    // choice waits for the conversation's next open.
    if (exit === undefined) {
      return {
        text:
          `This conversation opens on ${target.name} from now on.${signIn}\n` +
          `Terminal: exit, then run \`claude --resume ${sessionId}\`. VS Code: close this tab and reopen the conversation.`,
      }
    }

    // A newer ask replaces a queued one. Idle, or forced, the switch happens
    // as soon as this command has finished.
    state.pending = { target: target.name, force: ask.force, exit }
    const wait = await waitingFor($, state)
    const count = wait.tasks.length + (wait.turn ? 1 : 0)
    if (ask.force || count === 0) {
      await $.clock.after(0, () => carryOut($, state))
      const stopping = count === 0 ? '' : `, stopping ${describeWait(wait)}`
      return { text: `${leadOf(exit, target.name)}${stopping}: ${afterOf(exit, 'it')}${signIn}` }
    }
    $.ui.status(`account ${current ?? '(unknown)'}, switching to ${target.name}`)
    const stay = current === undefined ? '' : ` To stay on ${current}, type /account ${current}.`
    return {
      text:
        `Switch to ${target.name} queued: waiting for ${describeWait(wait)} to end. ` +
        `Then ${afterOf(exit, target.name)}${signIn}\n` +
        `To switch now and stop ${count === 1 ? 'it' : 'them'}, type /account ${target.name} now.${stay}`,
    }
  })
}
