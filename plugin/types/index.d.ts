// cc-accounts' contract: the named values it keeps in a session's $.state.

// The switching state a hot reload of the plugin must not lose (saved.ts).
export type CcAccountsSwitching = {
  pending: CcAccountsPending | null
  tasks: CcAccountsTask[]
  turns: number
  answered: string | null
  stranded: string | null
  strandedNote: string | null
}

// A queued switch, less how this process ends, which is read again.
export type CcAccountsPending = {
  target: string
  force: boolean
  from?: string
  stop?: { window: string } | { error: string }
}

// Background work the last Stop hook listed or a tool call started.
export type CcAccountsTask = { id: string; type: string; description: string }

declare module 'claude-code' {
  interface PluginState {
    'cc-accounts': { switching: CcAccountsSwitching }
  }
}
