// Carrying out a /account switch: ending this process so it reopens on the
// target account, once that stops nothing. Ending the process stops the turn
// in flight and all background work (subagents, shells, monitors), so a
// switch waits for the turn to end and the work to finish unless forced.
import type { EngineInterface } from 'claude-code'
import { describeTasks, ENDED_AGENT, nameTask, parseRecord, type Cron, type Task } from './background'
import { followUpText } from './usage'
import { record, type Context } from './context'

// How this process ends for a switch, by how cca started it. A terminal: cca
// waits on the process, reads the switch file and resumes the conversation
// on the target account. VS Code: cca-stream waits on it the same way, with
// the panel still attached, when it gave the process a switch file; without
// one (a process started before cca-stream existed), the extension starts a
// new process at the next message, which cca opens on the recorded account.
export type Exit =
  | { kind: 'terminal'; switchFile: string; sessionId: string }
  | { kind: 'stream'; pid: string; switchFile: string | undefined; sessionId: string }

// The switch asked for and not carried out yet: from which account, and, for
// a move the usage limit forced, which window ran out.
export type Pending = { target: string; force: boolean; exit: Exit; from: string | undefined; limit: string | undefined }

// What a switch waits for: the turn in flight and the background work.
export type Wait = { turn: boolean; tasks: Task[] }

// One process's state: Claude Code loads the module once per process, and
// /account only ever ends its own process.
export type SwitchState = {
  root: string | undefined
  // Whether a person is at the prompt (session.start): false for `-p` and the SDK.
  interactive: boolean
  turns: number
  tasks: Map<string, Task>
  // The scheduled wakeups the last turn's Stop hook listed.
  crons: Cron[]
  pending: Pending | undefined
  ending: boolean
}

export function newState(): SwitchState {
  return { root: undefined, interactive: false, turns: 0, tasks: new Map(), crons: [], pending: undefined, ending: false }
}

// Where the plugin's Stop hook (record-tasks.py) leaves a session's
// background work, and where turn.start marks a turn in flight.
export function recordFile(root: string, sessionId: string): string {
  return `${root}/background/${sessionId}`
}

// Whether something waits on this process to reopen the conversation.
function reopens(exit: Exit): boolean {
  return exit.switchFile !== undefined
}

// `Switched to work`, and what then happens, of `it` or of a name.
export function leadOf(exit: Exit, target: string): string {
  return reopens(exit) ? `Switching to ${target}` : `Switched to ${target}`
}

export function afterOf(exit: Exit, noun: string): string {
  if (!reopens(exit)) return `your next message continues this conversation on ${noun}.`
  return exit.kind === 'terminal'
    ? `this session closes and reopens on ${noun}.`
    : `this conversation reopens on ${noun} in this tab.`
}

// `this turn and 1 background task (shell "npm test")`
export function describeWait(wait: Wait): string {
  const parts = [wait.turn ? 'this turn' : '', wait.tasks.length > 0 ? describeTasks(wait.tasks) : '']
  return parts.filter(part => part !== '').join(' and ')
}

// The work a switch would stop now. The agent list is live; shells, monitors
// and workflows are as the last turn's Stop hook listed them, with the ones
// tool calls started since.
export async function waitingFor($: EngineInterface, state: SwitchState): Promise<Wait> {
  for (const agent of await $.agent.list()) {
    if (ENDED_AGENT.has(agent.status)) state.tasks.delete(agent.id)
    else if (agent.status !== 'idle' && !state.tasks.has(agent.id)) {
      state.tasks.set(agent.id, { id: agent.id, type: 'subagent', description: agent.description })
    }
  }
  return { turn: state.turns > 0, tasks: [...state.tasks.values()] }
}

// At a main-loop turn's end: the work its Stop hook listed replaces what was
// known. A turn that ended without Stop (interrupted, an API error such as a
// usage limit) left the mark turn.start wrote, and what was known stands.
export async function readRecord($: EngineInterface, state: SwitchState): Promise<void> {
  if (state.root === undefined) return
  const file = recordFile(state.root, await $.session.id())
  if (!(await $.fs.exists(file))) return
  const found = parseRecord(await $.fs.read(file))
  if (found === undefined) {
    $.ui.log(`cc-accounts: ${file} is not a task list; /account goes by the background work it saw start.`)
    return
  }
  if (found.kind !== 'tasks') return
  state.crons = found.crons
  state.tasks.clear()
  for (const task of found.tasks) state.tasks.set(task.id, task)
}

// Whether a process still runs.
async function alive($: EngineInterface, pid: string): Promise<boolean> {
  const { exitCode } = await $.process.run(['kill', '-0', pid])
  return exitCode === 0
}

// Ends this process so the extension restarts the conversation on the target
// account. SIGINT ends an idle stream-json session with exit 0. A switch waits
// for the turn to end, but a forced one, or a turn a queued message starts
// between the check and the signal, finds the session mid-turn, where the
// first SIGINT only stops the turn (2026-10-24: two processes on one
// conversation). So each signal is followed by a wait for the exit, the
// second SIGINT ends the now idle session, and SIGTERM is the last resort
// (exit 143, which the panel shows as a failure, though the conversation
// still reopens at the next message). The waits stay well inside a
// dispatch's budget.
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

// Line one: the account and the conversation; the rest: the follow-up.
export function switchRequest(target: string, sessionId: string, followUp: string | undefined): string {
  return `${target} ${sessionId}\n${followUp === undefined ? '' : `${followUp}\n`}`
}

async function runExit($: EngineInterface, exit: Exit, target: string, followUp: string | undefined): Promise<void> {
  if (exit.switchFile !== undefined) await $.fs.write(exit.switchFile, switchRequest(target, exit.sessionId, followUp))
  if (exit.kind === 'terminal') {
    try {
      await $.command.run({ command: 'exit', args: '' })
    } catch (error) {
      $.ui.log(`cc-accounts: /exit failed (${String(error)}); exit and cca will switch.`)
    }
    return
  }
  const failure = await endProcess($, exit.pid)
  if (failure !== undefined) {
    $.ui.log(`cc-accounts: could not end this session (${failure}); close this tab and reopen the conversation.`)
  }
}

// Ends this process for the pending switch once nothing it would stop is
// running, or at once when forced. Runs from a timer, never inside a
// command: a command cannot run /exit from inside itself.
export async function carryOut($: EngineInterface, state: SwitchState): Promise<void> {
  if (state.pending === undefined || state.ending) return
  if (!state.pending.force) {
    const wait = await waitingFor($, state)
    if (wait.turn || wait.tasks.length > 0) return
  }
  // Checked again: another timer may have carried it out during the wait.
  if (state.pending === undefined || state.ending) return
  const { exit, target, from, limit } = state.pending
  // What the reopened conversation is told, as things stand now: the work a
  // forced move stops, which a limit-forced one asks it to start again, and
  // the wakeups every move drops.
  const stopped = limit === undefined ? [] : (await waitingFor($, state)).tasks.map(nameTask)
  const followUp = followUpText({ from, to: target, limit, stopped, crons: state.crons })
  state.pending = undefined
  state.ending = true
  try {
    await runExit($, exit, target, followUp)
  } catch (error) {
    $.ui.log(`cc-accounts: the switch to ${target} failed (${String(error)}); type /account ${target} again.`)
  } finally {
    state.ending = false
  }
}

// What requestSwitch did: started the switch (it runs once the caller's
// command or hook has returned), queued it behind `wait`, or, for a process
// cca did not start, only recorded the account for the conversation's next open.
export type SwitchAsked =
  | { kind: 'started'; exit: Exit; stopping: Wait }
  | { kind: 'queued'; exit: Exit; wait: Wait }
  | { kind: 'recorded' }

// Moves this conversation to `target`: /account's switch and the balancer's.
// The conversation is recorded on `target` at once, so it opens there however
// this process ends; the process ends once its turn and background work have
// finished, or at once when forced. A newer request replaces a queued one.
export async function requestSwitch(
  $: EngineInterface,
  state: SwitchState,
  ctx: Context,
  exit: Exit | undefined,
  ask: { target: string; force: boolean; limit?: string },
): Promise<SwitchAsked> {
  await record($, ctx, await $.session.id(), ask.target)
  if (exit === undefined) return { kind: 'recorded' }
  state.pending = { target: ask.target, force: ask.force, exit, from: ctx.current?.name, limit: ask.limit }
  const wait = await waitingFor($, state)
  if (ask.force || (!wait.turn && wait.tasks.length === 0)) {
    await $.clock.after(0, () => carryOut($, state))
    return { kind: 'started', exit, stopping: wait }
  }
  return { kind: 'queued', exit, wait }
}
