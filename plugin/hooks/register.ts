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

// Whether a process still runs.
async function alive($: EngineInterface, pid: string): Promise<boolean> {
  const { exitCode } = await $.process.run(['kill', '-0', pid])
  return exitCode === 0
}

// Ends this process so the extension restarts the conversation on the target
// account. SIGINT ends an idle stream-json session with exit 0, but a session
// in the middle of a turn reads its first SIGINT as "stop the turn" and keeps
// running, which left two processes on one conversation (2026-10-24). So each
// signal is followed by a wait for the exit, the second SIGINT ends the now
// idle session, and SIGTERM is the last resort (exit 143, which the panel
// shows as a failure, though the conversation still reopens at the next
// message). The waits stay well inside a dispatch's budget.
const END_STEPS: readonly { signal: string; waitMs: number }[] = [
  { signal: '-INT', waitMs: 3000 },
  { signal: '-INT', waitMs: 2000 },
  { signal: '-TERM', waitMs: 2000 },
]
const END_POLL_MS = 500

async function endProcess($: EngineInterface, pid: string): Promise<string | undefined> {
  for (const step of END_STEPS) {
    const { exitCode, stderr } = await $.process.run(['kill', step.signal, pid])
    if (exitCode !== 0) return `kill ${step.signal} failed: ${stderr.trim()}`
    for (let waited = 0; waited < step.waitMs; waited += END_POLL_MS) {
      await $.clock.sleep(END_POLL_MS)
      if (!(await alive($, pid))) return undefined
    }
  }
  return `still running after ${END_STEPS.map(step => `SIG${step.signal.slice(1)}`).join(', ')}`
}

// cca resumes a conversation on the account it last ran on.
async function record($: EngineInterface, ctx: Context, sessionId: string, name: string): Promise<void> {
  await $.fs.write(`${ctx.root}/by-session/${sessionId}`, `${name}\n`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'account',
      description: 'Show or switch the Claude account this session runs on',
      argumentHint: '[name | default <name>]',
    })
    const ctx = await context($)
    if (ctx?.current !== undefined) {
      $.ui.status(`account ${ctx.current.name}`)
      await record($, ctx, await $.session.id(), ctx.current.name)
    }
    return result
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

    if (target.name === ctx.current?.name) return { text: `This session already runs on ${target.name}.` }
    const sessionId = await $.session.id()
    await record($, ctx, sessionId, target.name)
    const signIn = (await emailOf($, target, ctx.home)) === undefined
      ? ` ${target.name} is not signed in yet: sign in with /login when it opens.`
      : ''

    // How cca started this process, and whether it is this process (a claude
    // started inside a session inherits the variables of the session's own).
    const mode = await $.env.get('CCA_MODE')
    const ccaPid = await $.env.get('CCA_PID')
    const ids = mode === undefined ? undefined : await processIds($)

    // A terminal: cca waits on this process. Leave the request and exit; cca
    // resumes the conversation on the target account, flags kept.
    const switchFile = await $.env.get('CLAUDE_ACCOUNT_SWITCH_FILE')
    if (mode === 'terminal' && switchFile && ids?.parent === ccaPid) {
      await $.fs.write(switchFile, `${target.name} ${sessionId}\n`)
      // A command.run hook may not run a command (it would wait on itself), so
      // the timer's own dispatch runs /exit, queued until this one has finished.
      await $.clock.after(0, async () => {
        try {
          await $.command.run({ command: 'exit', args: '' })
        } catch (error) {
          $.ui.log(`cc-accounts: /exit failed (${String(error)}); exit and cca will switch.`)
        }
      })
      return { text: `Switching to ${target.name}: this session closes and reopens on it.${signIn}` }
    }

    // VS Code: the extension owns this process and starts a new one, through
    // cca, at the next message once it ends.
    if (mode === 'stream' && ids !== undefined && ids.self === ccaPid) {
      const self = ids.self
      await $.clock.after(0, async () => {
        const failure = await endProcess($, self)
        if (failure !== undefined) {
          $.ui.log(`cc-accounts: could not end this session (${failure}); close this tab and reopen the conversation.`)
        }
      })
      return { text: `Switched to ${target.name}: your next message continues this conversation on it.${signIn}` }
    }

    // Started without cca: the process cannot change its own login, so the
    // choice waits for the conversation's next open.
    return {
      text:
        `This conversation opens on ${target.name} from now on.${signIn}\n` +
        `Terminal: exit, then run \`claude --resume ${sessionId}\`. VS Code: close this tab and reopen the conversation.`,
    }
  })
}
