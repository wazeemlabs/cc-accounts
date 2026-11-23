// cc-accounts' contract: the named values it keeps in a session's $.state.

// The switching state a hot reload of the plugin must not lose (saved.ts).
export type CcAccountsSwitching = {
  pending: CcAccountsPending | null
  tasks: CcAccountsTask[]
  turns: number
  answered: string | null
  stranded: string | null
  strandedNote: string | null
  // Whether the conversation called the Claude in Chrome tools: absent in what
  // a plugin before 0.21.0 saved, read as no.
  browser?: boolean
  // What stopped the last turn of a session that waits for room: absent in
  // what a plugin before 0.26.0 saved, read as not waiting.
  waiting?: { window: string } | { error: string } | null
}

// A queued switch, less how this process ends, which is read again.
export type CcAccountsPending = {
  target: string
  force: boolean
  from?: string
  stop?: { window: string } | { error: string }
  // Who asked: absent in what a plugin before 0.16.0 saved, read as a person.
  by?: 'person' | 'balancer'
}

// Background work the last Stop hook listed or a tool call started.
export type CcAccountsTask = { id: string; type: string; description: string }

// The dashboard pane's picture of the machine, as its last refresh read it
// (dashboard.ts), with what the person is being asked to confirm and the
// answer to the last button pressed.
export type CcAccountsDashboard = {
  accounts: CcAccountsDashAccount[]
  sessions: CcAccountsDashSession[]
  // The session whose Close waits for a second press, since it would stop work.
  confirm: string | null
  note: string
}

// `fiveUsed`, `weekUsed`: percentages, null with no reading. `spent`: the
// words for an account with a window at its limit.
export type CcAccountsDashAccount = {
  name: string
  isSignedIn: boolean
  fiveUsed: number | null
  fiveReset: string
  weekUsed: number | null
  weekReset: string
  spent: string | null
  sessions: number
  isCurrent: boolean
  isStart: boolean
}

// `busy`: why closing it would stop work, null when it would stop none.
export type CcAccountsDashSession = {
  id: string
  name: string
  where: string
  state: string
  busy: string | null
  kb: number
  isStale: boolean
  isHere: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'cc-accounts': { switching: CcAccountsSwitching; dashboard: Shaped<CcAccountsDashboard> }
  }
}
