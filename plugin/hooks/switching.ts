// Carrying out a /account switch: ending this process so it reopens on the
// target account, once that stops nothing. Ending the process stops the turn
// in flight and all background work (subagents, shells, monitors), so a
// switch waits for the turn to end and the work to finish unless forced.
import type { EngineInterface } from 'claude-code'
import { describeTasks, ENDED_AGENT, nameTask, parseRecord, type Task } from './background'
import { followUpText, type Move, type Stop } from './usage'
import { describeError, record, type Context } from './context'

// How this process ends for a switch, by how cca started it. A terminal: cca
// waits on the process, reads the switch file and resumes the conversation
// on the target account. VS Code: cca-stream waits on it the same way, with
// the panel still attached, when it gave the process a switch file; without
// one (a process started before cca-stream existed), the extension starts a
// new process at the next message, which cca opens on the recorded account.
// `supervisor`: cca-stream's pid, told when a switch it holds input for is
// withdrawn.
export type Exit =
  | { kind: 'terminal'; switchFile: string; sessionId: string }
  | { kind: 'stream'; pid: string; switchFile: string | undefined; supervisor: string | undefined; sessionId: string }

// The switch asked for and not carried out yet: from which account, and, for
// a move the account forced by stopping a turn, what stopped it.
export type Pending = { target: string; force: boolean; exit: Exit; from: string | undefined; stop: Stop | undefined }

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
  pending: Pending | undefined
  ending: boolean
  // Whether a main-loop turn ended while the process was being ended: one a
  // message started after the switch was decided, which the switch cut short.
  cutTurn: boolean
  // The model that last answered a main-loop turn in this process.
  answered: string | undefined
  // The folder the session started in, which names its project.
  cwd: string | undefined
}

export function newState(): SwitchState {
  return {
    root: undefined,
    interactive: false,
    turns: 0,
    tasks: new Map(),
    pending: undefined,
    ending: false,
    cutTurn: false,
    answered: undefined,
    cwd: undefined,
  }
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
// still reopens at the next message). `between` runs before each signal
// after the first, while the process still runs. The waits stay well inside
// a dispatch's budget.
const END_STEPS: readonly { signal: string; waitMs: number }[] = [
  { signal: '-INT', waitMs: 3000 },
  { signal: '-INT', waitMs: 2000 },
  { signal: '-TERM', waitMs: 2000 },
]
const END_POLL_MS = 500

async function endProcess($: EngineInterface, pid: string, between: () => Promise<void>): Promise<string | undefined> {
  for (const [index, step] of END_STEPS.entries()) {
    if (index > 0) await between()
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

// A switch that could not end the process is withdrawn: nothing should
// reopen the conversation when this process ends some other way, and
// cca-stream, which holds the panel's input while the switch file exists,
// is told to pass it to this process again.
async function withdraw($: EngineInterface, exit: Exit): Promise<void> {
  if (exit.kind !== 'stream' || exit.switchFile === undefined) return
  const removed = await $.process.run(['rm', '-f', exit.switchFile])
  if (removed.exitCode !== 0) throw new Error(`could not remove ${exit.switchFile}: ${removed.stderr.trim()}`)
  if (exit.supervisor === undefined) return
  const told = await $.process.run(['kill', '-USR1', exit.supervisor])
  if (told.exitCode !== 0) throw new Error(`could not tell cca-stream ${exit.supervisor}: ${told.stderr.trim()}`)
}

// Ends this process for `pending`; `move` is what the reopened conversation
// is told. A turn a message started after the switch was decided (one the
// panel queued as the last turn ended) is cut short by the first SIGINT, so
// before the next signal the request is rewritten to tell the conversation
// to carry on, unless the person forced the switch to stop the work.
async function runExit($: EngineInterface, state: SwitchState, pending: Pending, move: Move): Promise<void> {
  const { exit, target } = pending
  const ask = async (followUp: string | undefined) => {
    if (exit.switchFile !== undefined) await $.fs.write(exit.switchFile, switchRequest(target, exit.sessionId, followUp))
  }
  await ask(followUpText(move))
  if (exit.kind === 'terminal') {
    try {
      await $.command.run({ command: 'exit', args: '' })
    } catch (error) {
      $.ui.log(`cc-accounts: /exit failed (${describeError(error)}); exit and cca will switch.`)
    }
    return
  }
  let toldCut = false
  const failure = await endProcess($, exit.pid, async () => {
    if (toldCut || pending.force || !(state.cutTurn || state.turns > 0)) return
    toldCut = true
    await ask(followUpText({ ...move, interrupted: true }))
  })
  if (failure === undefined) return
  $.ui.log(
    `cc-accounts: could not end this session (${failure}), so it runs on as it is; ` +
      `close this tab and reopen the conversation to move it to ${target}.`,
  )
  await withdraw($, exit)
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
  // Claimed before anything else is awaited: another timer that got this far
  // meanwhile (a forced move schedules one, and so does its turn's end)
  // stops here.
  const pending = state.pending
  if (pending === undefined || state.ending) return
  state.pending = undefined
  state.ending = true
  state.cutTurn = false
  const { exit, target, from, stop } = pending
  try {
    // What the reopened conversation is told, as things stand now: the work a
    // forced move stops, which one the account forced asks it to start again.
    // Only a switch file carries a follow-up.
    const stopped = stop === undefined ? [] : (await waitingFor($, state)).tasks.map(nameTask)
    await runExit($, state, pending, { from, to: target, stop, interrupted: false, stopped })
  } catch (error) {
    $.ui.log(`cc-accounts: the switch to ${target} failed (${describeError(error)}); type /account ${target} again.`)
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
  ask: { target: string; force: boolean; stop?: Stop },
): Promise<SwitchAsked> {
  await record($, ctx, await $.session.id(), ask.target)
  if (exit === undefined) return { kind: 'recorded' }
  state.pending = { target: ask.target, force: ask.force, exit, from: ctx.current?.name, stop: ask.stop }
  const wait = await waitingFor($, state)
  if (ask.force || (!wait.turn && wait.tasks.length === 0)) {
    await $.clock.after(0, () => carryOut($, state))
    return { kind: 'started', exit, stopping: wait }
  }
  return { kind: 'queued', exit, wait }
}
