// The world beneath the plugin in its tests: an in-memory disk, the session's
// id, the processes it signals, its agents, the tools the engine answers
// (CronList, so a test can give a session wakeups the plugin must leave
// alone), and the turns of the main loop with what their Stop hook
// (record-tasks.py) leaves.
import { mock, type Engine } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'
import type { Task } from '../hooks/background'
import { followUpText, formatReading, readingOf, type Move } from '../hooks/usage'

// A scheduled wakeup as CronList lists it.
export type Cron = { schedule: string; recurring: boolean; prompt: string }

export const HOME = '/Users/me'
export const ROOT = `${HOME}/.claude-shared/accounts`
export const SESSION = '0f4a6c1e-1111-4222-8333-944455556666'
export const SWITCH = `${ROOT}/switch/123`
export const RECORD = `${ROOT}/background/${SESSION}`
export const BY_SESSION = `${ROOT}/by-session/${SESSION}`
// This process is 500; cca (terminal) is its parent, 400.
export const SELF = '500'
export const PARENT = '400'
export const TERMINAL = { CLAUDE_ACCOUNT: '1', CCA_MODE: 'terminal', CCA_PID: PARENT, CLAUDE_ACCOUNT_SWITCH_FILE: SWITCH }
export const STREAM = { CLAUDE_ACCOUNT: '1', CCA_MODE: 'stream', CCA_PID: SELF }
// VS Code under cca-stream (pid 123), which reopens the conversation from the switch file.
export const SUPERVISOR = '123'
export const SUPERVISED = { ...STREAM, CLAUDE_ACCOUNT_SWITCH_FILE: SWITCH, CCA_STREAM_PID: SUPERVISOR }
export const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

export const run = (args: string) => ({
  command: 'account',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
}) as const

export const SHELL: Task = { id: 'b1', type: 'shell', description: 'npm test' }
export const SCOUT: Task = { id: 'a1', type: 'subagent', description: 'scout' }

// `signalsToDie`: how many signals the process takes before it exits; a
// session in the middle of a turn survives its first SIGINT.
export function world(on: On, env: Record<string, string>, signalsToDie = 1) {
  const files = new Map<string, string>([
    [`${ROOT}/accounts.tsv`, `1\t${HOME}/.claude\n2\t${HOME}/.claude-two\n3\t${HOME}/.claude-three\n`],
    [`${HOME}/.claude.json`, '{"oauthAccount":{"emailAddress":"one@example.com"}}'],
    [`${HOME}/.claude-two/.claude.json`, '{"oauthAccount":{"emailAddress":"two@example.com"}}'],
  ])
  const ran: string[] = []
  const statuses: (string | undefined)[] = []
  const logs: string[] = []
  const killed: string[][] = []
  const agents: AgentInfo[] = []
  // What each tool answers, by tool name, and the tools that refuse.
  const results = new Map<string, unknown>([['CronList', { jobs: [] }]])
  const denied = new Map<string, string>()
  // Every path written with fs.write, and the cca-stream pids told a switch was withdrawn.
  const writes: string[] = []
  const released: string[] = []
  // Pids of other sessions' processes that still run.
  const running = new Set<string>()
  // The rate-limit windows the session's last response reported.
  const limits: { kind: string; percentUsed: number; resetsAt?: string }[] = []
  // The folder the session's shell is in was deleted (a removed worktree):
  // a command started there cannot start.
  const folder = { gone: false }
  // Files that cannot be saved, by path prefix: renaming into place fails.
  const failWrites = new Set<string>()
  mock.env(on, { HOME, ...env })
  const clock = mock.clock(on)
  // A directory exists while it holds a file.
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) || [...files.keys()].some(path => path.startsWith(`${e.path}/`)) }))
  on('fs.read', async (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.list', async (_$, e) => {
    const dir = `${e.path ?? ''}/`
    const names = [...files.keys()].filter(path => path.startsWith(dir) && !path.slice(dir.length).includes('/'))
    return { value: names.map(path => ({ name: path.slice(dir.length), kind: 'file', size: 0, mtimeMs: 0, isLink: false })) as never }
  })
  on('fs.write', async (_$, e) => {
    writes.push(e.path)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('session.id', async () => ({ value: SESSION }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [...limits] } as never }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('command.run', { command: 'exit' }, async (_$, e) => {
    ran.push(e.command)
    return {}
  })
  // The conversation's transcript, which the plugin reads the end of; null: unreadable.
  const transcript: { tail: string | null } = { tail: '' }
  // The session's model setting, as the /config menu shows it.
  const settings = { model: 'claude-fable-5-1' }
  on('config.list', async () => ({
    value: [{ key: 'model', label: 'Model', kind: 'select', value: settings.model, provider: { kind: 'core' } }] as never,
  }))
  // How long the agent list takes to answer, in clock milliseconds: a wait
  // that lets another timer run meanwhile.
  const slow = { agentsMs: 0 }
  on('agent.list', async () => {
    if (slow.agentsMs > 0) await clock.sleep(slow.agentsMs)
    return { value: agents }
  })
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.call', async (_$, e) => {
    const deny = denied.get(e.tool)
    return deny === undefined ? { result: results.get(e.tool) as never, text: '' } : { deny }
  })
  let signals = 0
  const done = (exitCode: number, stderr = '') =>
    ({ value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', async (_$, e) => {
    if (folder.gone && e.init?.cwd === undefined) throw new Error(`$.process.run(${e.argv[0]}) failed to start: ENOENT`)
    if (e.argv[0] === 'mv') {
      // mv -f <from> <to>
      const to = e.argv[3] ?? ''
      if ([...failWrites].some(prefix => to.startsWith(prefix))) return done(1, `mv: rename to ${to}: Permission denied`)
      const text = files.get(e.argv[2] ?? '')
      if (text === undefined) return done(1, 'No such file or directory')
      files.set(e.argv[3] ?? '', text)
      files.delete(e.argv[2] ?? '')
      return done(0)
    }
    if (e.argv[0] === 'rm') {
      files.delete(e.argv[2] ?? '')
      return done(0)
    }
    if (e.argv[0] === 'kill' && e.argv[1] === '-USR1') {
      released.push(e.argv[2] ?? '')
      return done(0)
    }
    if (e.argv[0] === 'ps') {
      // ps -o pid= -p a,b,c: the ones in `running`.
      const asked = (e.argv[4] ?? '').split(',')
      const stdout = asked.filter(pid => running.has(pid)).map(pid => `${pid}\n`).join('')
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const tailCommand = /tail (?:-q )?-(n|c) ([0-9]+)/.exec(e.argv[2] ?? '')
    if (e.argv[0] === '/bin/sh' && tailCommand !== null) {
      // The end of the transcript as tail cuts it (-n lines, -c bytes), for
      // why a turn failed, and cut at 4 MiB as $.process.run does.
      const text = transcript.tail
      if (text === null) return done(1, 'tail: No such file or directory')
      const count = Number(tailCommand[2])
      const end = tailCommand[1] === 'c'
        ? text.slice(Math.max(0, text.length - count))
        : text.split(/(?<=\n)/).slice(-count).join('')
      const limit = 4 * 1024 * 1024
      return {
        value: { exitCode: 0, stdout: end.slice(0, limit), stderr: '', isStdoutTruncated: end.length > limit, isStderrTruncated: false },
      }
    }
    if (e.argv[0] === '/bin/sh') {
      return { value: { exitCode: 0, stdout: `${SELF}\n ${PARENT}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const exited = signals >= signalsToDie
    if (e.argv[1] === '-0') {
      // kill -0: whether the process still runs.
      return { value: { exitCode: exited ? 1 : 0, stdout: '', stderr: exited ? 'No such process' : '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    killed.push([...e.argv])
    signals += 1
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.log', async (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', async (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  return {
    files, ran, statuses, logs, clock, killed, agents, results, denied, limits, running, writes, released, slow, transcript, settings,
    folder, failWrites,
  }
}

// The API-error row Claude Code appends to the transcript when `error` ends a turn.
export function apiError(error: string): string {
  return `${JSON.stringify({ type: 'assistant', isApiErrorMessage: true, error, message: { role: 'assistant', content: [] } })}\n`
}

// The session holds these wakeups, as CronList lists them.
export function schedule(w: ReturnType<typeof world>, crons: readonly Cron[]): void {
  w.results.set('CronList', {
    jobs: crons.map((cron, index) => ({
      id: `c${index}`,
      cron: cron.schedule,
      humanSchedule: cron.schedule,
      prompt: cron.prompt,
      ...(cron.recurring && { recurring: true }),
      durable: false,
    })),
  })
}

let turns = 0

// A main-loop turn starts; its id.
export async function startTurn($: Engine): Promise<string> {
  turns += 1
  const turnId = `turn-${turns}`
  await $.turn.start({ text: 'go', turnId })
  return turnId
}

// The turn ends. With `stop`, its Stop hook ran and listed that work; without
// (an interrupt, an API error), it did not.
export async function endTurn(
  $: Engine,
  w: ReturnType<typeof world>,
  turnId: string,
  stop?: readonly Task[],
): Promise<void> {
  if (stop !== undefined) w.files.set(RECORD, `${JSON.stringify({ tasks: stop })}\n`)
  const reason = stop === undefined ? 'error' : 'answer'
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason })
}

// A whole turn whose Stop hook listed `stop`, after which the session holds
// the wakeups `crons`.
export async function turn(
  $: Engine,
  w: ReturnType<typeof world>,
  stop: readonly Task[],
  crons: readonly Cron[] = [],
): Promise<void> {
  schedule(w, crons)
  await endTurn($, w, await startTurn($), stop)
}

type World = ReturnType<typeof world>

// A reset time no test reaches.
export const LATER = '2100-01-01T00:00:00Z'

// The switch request for a move from 1 to 2.
export function request(move: Partial<Move> = {}): string {
  const text = followUpText({ from: '1', to: '2', stop: undefined, interrupted: false, stopped: [], ...move })
  return `2 ${SESSION}\n${text === undefined ? '' : `${text}\n`}`
}

// The session's own account (1) reports these windows.
export function limits(w: World, fiveHour: number, weekly = 0, resetsAt = LATER): void {
  w.limits.splice(0, w.limits.length,
    { kind: 'five_hour', percentUsed: fiveHour, resetsAt },
    { kind: 'seven_day', percentUsed: weekly, resetsAt: LATER })
}

// Another account's reading, as one of its sessions saved it.
export function saved(w: World, account: string, fiveHour: number): void {
  const reading = readingOf(account, 0, [{ kind: 'five_hour', percentUsed: fiveHour, resetsAt: LATER }])
  w.files.set(`${ROOT}/usage/${account}.json`, formatReading(reading))
}

export function signInThree(w: World): void {
  w.files.set(`${HOME}/.claude-three/.claude.json`, '{"oauthAccount":{"emailAddress":"three@example.com"}}')
}

// Another live (or ended) session on `account`, started in `cwd`.
export function session(w: World, pid: number, account: string, live = true, cwd = '/x', name = ''): void {
  w.files.set(`${HOME}/.claude-shared/sessions/${pid}.json`, JSON.stringify({ pid, sessionId: `s-${pid}`, cwd, name }))
  w.files.set(`${ROOT}/by-session/s-${pid}`, `${account}\n`)
  if (live) w.running.add(String(pid))
}
