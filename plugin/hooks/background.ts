// The work a session runs in the background (subagents, shells, monitors,
// workflows), which ending its process would stop. Pure: register.ts does
// the reading and writing.
//
// Claude Code lists that work in its Stop hook's input (`background_tasks`)
// at the end of every main-loop turn. A hooks module's own classic.Stop hook
// is not reliable for it: where the built-in cc-plugin-sec-default plugin is
// seated (Team and Enterprise organizations, managed settings) it sends the
// event on past every installed plugin. So the plugin's command hook,
// record-tasks.py, saves the list to a file, and the module reads it when the
// turn completes. A turn that ends without Stop (interrupted, or an API error
// such as a usage limit) leaves the file as the module marked it at the
// turn's start, and the work started meanwhile is known from the tool calls
// that started it.

export type Task = { id: string; type: string; description: string }

// A scheduled wakeup (CronCreate, ScheduleWakeup, /loop). It lives in the
// process, so a switch drops it, and the reopened conversation is asked to
// set it again.
export type Cron = { schedule: string; recurring: boolean; prompt: string }

// The record file: the work in flight and the wakeups held when the last turn
// ended, or the mark that a turn started and no Stop has run since.
export type TaskRecord = { kind: 'tasks'; tasks: Task[]; crons: Cron[] } | { kind: 'turn'; turnId: string }

// Agent states after which an agent no longer runs (AgentStatus).
export const ENDED_AGENT = new Set(['completed', 'failed', 'killed'])

export function turnMark(turnId: string): string {
  return `${JSON.stringify({ turn: turnId })}\n`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function taskOf(value: unknown): Task | undefined {
  if (!isObject(value) || typeof value.id !== 'string' || value.id === '' || typeof value.type !== 'string') {
    return undefined
  }
  const description = typeof value.description === 'string' ? value.description : ''
  return { id: value.id, type: value.type, description }
}

function cronOf(value: unknown): Cron | undefined {
  if (!isObject(value) || typeof value.schedule !== 'string') return undefined
  return {
    schedule: value.schedule,
    recurring: value.recurring === true,
    prompt: typeof value.prompt === 'string' ? value.prompt : '',
  }
}

// undefined: the file is not a record (a partial write, another version's).
// A record from before wakeups were saved has none.
export function parseRecord(text: string): TaskRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Not JSON: the caller reports it and keeps what it knew.
    return undefined
  }
  if (!isObject(value)) return undefined
  if (typeof value.turn === 'string') return { kind: 'turn', turnId: value.turn }
  if (!Array.isArray(value.tasks)) return undefined
  const tasks = value.tasks.map(taskOf)
  if (!tasks.every(task => task !== undefined)) return undefined
  if (value.crons !== undefined && !Array.isArray(value.crons)) return undefined
  const crons = ((value.crons as unknown[] | undefined) ?? []).map(cronOf)
  if (!crons.every(cron => cron !== undefined)) return undefined
  return { kind: 'tasks', tasks: tasks as Task[], crons: crons as Cron[] }
}

// The background task a tool call started, read from its input and result.
export function taskStarted(tool: string, input: Record<string, unknown>, result: unknown): Task | undefined {
  if (!isObject(result)) return undefined
  const said = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  const id = (key: string) => (typeof result[key] === 'string' && result[key] !== '' ? (result[key] as string) : undefined)
  let task: Task | undefined
  if (tool === 'Bash') {
    const taskId = id('backgroundTaskId')
    if (taskId) task = { id: taskId, type: 'shell', description: said('description') || said('command') }
  } else if (tool === 'Monitor') {
    const taskId = id('taskId')
    if (taskId) task = { id: taskId, type: 'monitor', description: said('description') || said('command') }
  } else if (tool === 'Agent' && result.status === 'async_launched') {
    const agentId = id('agentId')
    if (agentId) task = { id: agentId, type: 'subagent', description: said('description') }
  } else if ((tool === 'Agent' || tool === 'Workflow') && typeof result.status === 'string') {
    const taskId = id('taskId')
    if (taskId) task = { id: taskId, type: tool === 'Agent' ? 'remote agent' : 'workflow', description: said('description') }
  }
  return task
}

// `shell "npm test"`, or `monitor m1` for one with no description.
export function nameTask(task: Task): string {
  return task.description ? `${task.type} "${task.description}"` : `${task.type} ${task.id}`
}

// `2 background tasks (subagent "scout", shell "npm test")`
export function describeTasks(tasks: readonly Task[]): string {
  const names = tasks.map(nameTask)
  return `${tasks.length} background task${tasks.length === 1 ? '' : 's'} (${names.join(', ')})`
}
