// What a session knows about the accounts and how cca started it: read from
// cca's state directory and the environment cca set. Shared by /account and
// the balancer.
import type { EngineInterface } from 'claude-code'
import { configFileOf, currentAccount, emailIn, parseTable, type Account } from './accounts'
import type { Exit } from './switching'

export type Context = {
  home: string
  // cca's state directory (accounts.tsv, by-session, usage, ...).
  root: string
  // The directory every account shares (sessions, projects).
  shared: string
  accounts: Account[]
  current: Account | undefined
}

export async function context($: EngineInterface): Promise<Context | undefined> {
  const home = await $.env.get('HOME')
  if (home === undefined) return undefined
  // cca names its directories; a session started without cca has the defaults.
  const shared = (await $.env.get('CCA_SHARED')) || `${home}/.claude-shared`
  const root = (await $.env.get('CCA_ROOT')) || `${shared}/accounts`
  const table = `${root}/accounts.tsv`
  if (!(await $.fs.exists(table))) return undefined
  const accounts = parseTable(await $.fs.read(table))
  const current = currentAccount(
    accounts,
    await $.env.get('CLAUDE_ACCOUNT'),
    await $.env.get('CLAUDE_CONFIG_DIR'),
    home,
  )
  return { home, root, shared, accounts, current }
}

export async function emailOf($: EngineInterface, account: Account, home: string): Promise<string | undefined> {
  const file = configFileOf(account, home)
  return (await $.fs.exists(file)) ? emailIn(await $.fs.read(file)) : undefined
}

// Where the plugin publishes the account a new session should start on, for
// cca: the account's name and a newline.
export function startFile(root: string): string {
  return `${root}/start`
}

export async function defaultName($: EngineInterface, ctx: Context): Promise<string | undefined> {
  const file = `${ctx.root}/default`
  if (!(await $.fs.exists(file))) return ctx.accounts[0]?.name
  return (await $.fs.read(file)).trim() || ctx.accounts[0]?.name
}

// Runs a command from `/`. $.process.run starts one in the session's folder
// by default, and a session can delete the folder it is in (a worktree it
// removed), after which no command starts there (2026-11-06: ENOENT).
export function run($: EngineInterface, argv: readonly string[]): ReturnType<EngineInterface['process']['run']> {
  return $.process.run(argv, { cwd: '/' })
}

// Writes started in this process, which name their temporary files.
let writesStarted = 0

// Writes a file other sessions and cca read while it may be rewritten: a
// temporary file beside it, named for this session and this write so that
// writers never share one, then renamed over it, so a reader sees the old
// text or the new and never half of it.
export async function writeAtomic($: EngineInterface, path: string, text: string): Promise<void> {
  writesStarted += 1
  const write = writesStarted
  const temp = `${path}.${await $.session.id()}.${write}.tmp`
  await $.fs.write(temp, text)
  const { exitCode, stderr } = await run($, ['mv', '-f', temp, path])
  if (exitCode !== 0) throw new Error(`could not save ${path}: ${stderr.trim()}`)
}

// cca resumes a conversation on the account it last ran on.
export async function record($: EngineInterface, ctx: Context, sessionId: string, name: string): Promise<void> {
  await writeAtomic($, `${ctx.root}/by-session/${sessionId}`, `${name}\n`)
}

// This process's id and its parent's, as decimal strings. $.process.run starts
// sh directly, so sh's parent is this process.
async function processIds($: EngineInterface): Promise<{ self: string; parent: string } | undefined> {
  const { exitCode, stdout } = await run($, ['/bin/sh', '-c', 'echo $PPID; ps -o ppid= -p $PPID'])
  const [self, parent] = stdout.split('\n').map(line => line.trim())
  return exitCode === 0 && self && parent ? { self, parent } : undefined
}

// How this process ends for a switch, or undefined when cca did not start it
// (or it is a claude started inside a session, which inherits the session's
// variables: CCA_PID then names another process).
export async function exitOf($: EngineInterface, sessionId: string): Promise<Exit | undefined> {
  const mode = await $.env.get('CCA_MODE')
  if (mode === undefined) return undefined
  const ccaPid = await $.env.get('CCA_PID')
  const ids = await processIds($)
  const switchFile = (await $.env.get('CLAUDE_ACCOUNT_SWITCH_FILE')) || undefined
  if (mode === 'terminal' && switchFile && ids?.parent === ccaPid) return { kind: 'terminal', switchFile, sessionId }
  if (mode === 'stream' && ids !== undefined && ids.self === ccaPid) {
    // cca-stream names itself to its child, to be told when a switch is withdrawn.
    const supervisor = switchFile ? (await $.env.get('CCA_STREAM_PID')) || undefined : undefined
    return { kind: 'stream', pid: ids.self, switchFile, supervisor, sessionId }
  }
  return undefined
}

// An error as a person reads it: the hooks engine hands some over as plain objects.
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    return typeof message === 'string' ? message : JSON.stringify(error)
  }
  return String(error)
}
