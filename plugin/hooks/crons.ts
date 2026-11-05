// The session's scheduled wakeups (CronCreate, ScheduleWakeup, /loop). They
// live in the process, so a switch drops them, and the reopened conversation
// is asked to set them again. They are read live from the CronList tool when
// a switch needs them. The Stop hook's session_crons would not do: it clips
// each prompt at 1000 characters, and it is not sent when the usage limit
// ends a turn (StopFailure runs instead), the move that needs it most.
import type { EngineInterface } from 'claude-code'
import { describeError } from './context'

export type Cron = { schedule: string; recurring: boolean; prompt: string }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// CronList's answer as the wakeups this process holds, or undefined when it
// is not the shape this version reads. CronList marks the session's own
// jobs, which live in the process, `durable: false`; any other job outlives
// the process and needs no handing over.
export function cronsOf(result: unknown): Cron[] | undefined {
  if (!isObject(result) || !Array.isArray(result.jobs)) return undefined
  const crons: Cron[] = []
  for (const job of result.jobs) {
    if (!isObject(job) || typeof job.cron !== 'string' || typeof job.prompt !== 'string') return undefined
    if (job.durable !== false) continue
    crons.push({ schedule: job.cron, recurring: job.recurring === true, prompt: job.prompt })
  }
  return crons
}

// The wakeups this process holds now, or undefined (and a log line) when
// they cannot be read.
export async function liveCrons($: EngineInterface): Promise<Cron[] | undefined> {
  let answer: Awaited<ReturnType<EngineInterface['tool']['call']>>
  try {
    answer = await $.tool.call({ tool: 'CronList' })
  } catch (error) {
    $.ui.log(`cc-accounts: could not list this session's scheduled wakeups (${describeError(error)}).`)
    return undefined
  }
  if (answer.deny !== undefined) {
    $.ui.log(`cc-accounts: could not list this session's scheduled wakeups (${answer.deny}).`)
    return undefined
  }
  const crons = cronsOf(answer.result)
  if (crons === undefined) {
    $.ui.log("cc-accounts: CronList answered in a shape this version does not read, so a switch cannot hand over this session's scheduled wakeups.")
  }
  return crons
}

// A wakeup as the conversation can set it again.
export function describeCron(cron: Cron): string {
  return `${cron.recurring ? 'recurring' : 'once'} at "${cron.schedule}" with the prompt ${JSON.stringify(cron.prompt)}`
}
