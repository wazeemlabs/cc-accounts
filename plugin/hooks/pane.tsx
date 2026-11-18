// The dashboard pane: every account with its use and a Switch button, every
// running session with its state, memory and a Close button. A press runs
// the same /account command a person would type, so the pane decides nothing
// itself; a Close that would stop work asks for a second press first.
import type { EngineInterface, On } from 'claude-code'
import { accountCommand } from './command'
import { context, describeError } from './context'
import { readBoard, refresh, refreshQuietly, setConfirm, PANE } from './dashboard'
import { memoryText } from './sessions'
import type { SwitchState } from './switching'

// How long after a press the picture is read again: ending a process and
// its helpers takes a few seconds (switching.ts, END_STEPS).
const SETTLE_MS = 8000

// Runs `/account <args>`, shows its answer, and reads the machine again now
// and once what it started has settled.
async function act($: EngineInterface, state: SwitchState, args: string): Promise<void> {
  let note: string
  try {
    note = (await accountCommand($, args, state)).text
  } catch (error) {
    note = `/account ${args} failed (${describeError(error)}).`
  }
  const ctx = await context($)
  if (ctx === undefined) return
  await refresh($, ctx, { confirm: null, note })
  await $.clock.after(SETTLE_MS, () => refreshQuietly($, ctx))
}

// `████░░░░░░` for 42: ten cells, a tenth of the window each.
export function textBar(used: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(used / 10)))
  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

async function reread($: EngineInterface): Promise<void> {
  const ctx = await context($)
  if (ctx !== undefined) await refreshQuietly($, ctx)
}

export function registerPane(on: On, state: SwitchState): void {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Progress } = $.ui.resolve(e)
    const { accounts, sessions, confirm, note } = await readBoard($)
    // A window's use: the surface's own bar, or on a Claude Code from before
    // Progress, one drawn in text.
    const meter = (label: string, used: number, reset: string) => {
      const words = `${used}% used · resets in ${reset}`
      return Progress === undefined
        ? <Text>{label.padEnd(7)}{textBar(used)} <Text dimColor>{words}</Text></Text>
        : <Progress label={label} value={used} max={100} valueText={words} />
    }
    const others = sessions.filter(session => !session.isHere)
    const stale = sessions.filter(session => session.isStale)
    const total = sessions.reduce((sum, session) => sum + session.kb, 0)
    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text bold>{sessions.length} sessions · {memoryText(total)}</Text>
          {accounts.filter(account => account.isCurrent).map(account => (
            <Text dimColor>{account.name}: 5h {account.fiveUsed ?? '-'}%, week {account.weekUsed ?? '-'}%</Text>
          ))}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>Accounts</Text>
          {accounts.map(account => (
            <Box key={`account-${account.name}`} flexDirection="column" marginTop={1}>
              <Box flexDirection="row" gap={1}>
                <Text bold>{account.name}</Text>
                <Text dimColor>
                  {[
                    `${account.sessions} session${account.sessions === 1 ? '' : 's'}`,
                    account.isCurrent ? 'this session' : '',
                    account.isStart ? 'new sessions start here' : '',
                  ].filter(part => part !== '').join(' · ')}
                </Text>
                {!account.isCurrent && account.isSignedIn && (
                  <Button key={`switch-${account.name}`} onPress={() => act($, state, account.name)}>Switch</Button>
                )}
              </Box>
              {!account.isSignedIn && <Text dimColor>not signed in</Text>}
              {account.isSignedIn && account.spent !== null && <Text color="warning">{account.spent}</Text>}
              {account.isSignedIn && account.fiveUsed === null && <Text dimColor>no reading yet</Text>}
              {account.isSignedIn && account.fiveUsed !== null && meter('5-hour', account.fiveUsed, account.fiveReset)}
              {account.isSignedIn && account.weekUsed !== null && meter('week', account.weekUsed, account.weekReset)}
            </Box>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>Sessions</Text>
          <Text dimColor>{sessions.length} running, holding {memoryText(total)} with the processes they started</Text>
          {sessions.map(session => (
            <Box key={`session-${session.id}`} flexDirection="column" marginTop={1}>
              <Box flexDirection="row" gap={1}>
                <Text bold wrap="truncate-end">{session.name}</Text>
                {session.isHere && <Text dimColor>this session</Text>}
                {session.isStale && <Text color="warning">idle over a day</Text>}
              </Box>
              <Box flexDirection="row" gap={1}>
                <Text dimColor>{session.where} · {session.state} · {memoryText(session.kb)}</Text>
                {!session.isHere && confirm !== session.id && (
                  <Button
                    key={`close-${session.id}`}
                    onPress={() => (session.busy === null
                      ? act($, state, `close ${session.id}`)
                      : setConfirm($, session.id))}
                  >
                    Close
                  </Button>
                )}
              </Box>
              {confirm === session.id && (
                <Box flexDirection="row" gap={1}>
                  <Text color="warning">It {session.busy}; closing stops that.</Text>
                  <Button key={`force-${session.id}`} variant="primary" onPress={() => act($, state, `close ${session.id} now`)}>Close anyway</Button>
                  <Button key={`keep-${session.id}`} onPress={() => setConfirm($, null)}>Keep</Button>
                </Box>
              )}
            </Box>
          ))}
          {others.length === 0 && <Text dimColor>No other session is running.</Text>}
        </Box>
        <Box flexDirection="row" gap={1}>
          {stale.length > 0 && (
            <Button key="close-stale" onPress={() => act($, state, 'close stale')}>
              Close {stale.length} idle over a day ({memoryText(stale.reduce((sum, session) => sum + session.kb, 0))})
            </Button>
          )}
          <Button
            key="refresh"
            onPress={() => reread($)}
          >
            Refresh
          </Button>
        </Box>
        {note !== '' && <Text dimColor>{note}</Text>}
      </Box>
    )
  })
}
