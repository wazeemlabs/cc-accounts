// The world beneath the plugin in its tests: an in-memory disk, the session's
// id, the processes it signals, its agents, the tool calls it sees, and the
// turns of the main loop with what their Stop hook (record-tasks.py) leaves.
import { mock, type Engine } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'
import type { Task } from '../hooks/background'

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
// VS Code under cca-stream, which reopens the conversation from the switch file.
export const SUPERVISED = { ...STREAM, CLAUDE_ACCOUNT_SWITCH_FILE: SWITCH }
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
  // What each tool answers, by tool name.
  const results = new Map<string, unknown>()
  // Pids of other sessions' processes that still run.
  const running = new Set<string>()
  // The rate-limit windows the session's last response reported.
  const limits: { kind: string; percentUsed: number; resetsAt?: string }[] = []
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
  on('agent.list', async () => ({ value: agents }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.call', async (_$, e) => ({ result: results.get(e.tool) as never, text: '' }))
  let signals = 0
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'ps') {
      // ps -o pid= -p a,b,c: the ones in `running`.
      const asked = (e.argv[4] ?? '').split(',')
      const stdout = asked.filter(pid => running.has(pid)).map(pid => `${pid}\n`).join('')
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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
  return { files, ran, statuses, logs, clock, killed, agents, results, limits, running }
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

// A whole turn whose Stop hook listed `stop`.
export async function turn($: Engine, w: ReturnType<typeof world>, stop: readonly Task[]): Promise<void> {
  await endTurn($, w, await startTurn($), stop)
}
