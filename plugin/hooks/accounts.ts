// The account table cca keeps (accounts.tsv: name, tab, config dir) and what
// /account's arguments ask for. Pure: register.ts does the reading and writing.

export type Account = { name: string; dir: string }

export type Ask =
  | { kind: 'list' }
  | { kind: 'switch'; name: string }
  | { kind: 'default'; name: string }
  | { kind: 'usage' }

export const USAGE = 'Usage: /account (list), /account <name> (switch this session), /account default <name>'

export function parseTable(text: string): Account[] {
  return text
    .split('\n')
    .flatMap(line => {
      const [name, dir, ...rest] = line.split('\t')
      return name && dir && rest.length === 0 ? [{ name, dir }] : []
    })
}

export function parseAsk(args: string): Ask {
  const words = args.trim().split(/\s+/).filter(word => word !== '')
  const [first, second, ...rest] = words
  if (first === undefined) return { kind: 'list' }
  if (second === undefined) return first === 'default' ? { kind: 'usage' } : { kind: 'switch', name: first }
  if (first === 'default' && rest.length === 0) return { kind: 'default', name: second }
  return { kind: 'usage' }
}

// The account this process runs on: cca names it in CLAUDE_ACCOUNT; a session
// started without cca is matched by its config dir, ~/.claude when unset.
export function currentAccount(
  accounts: readonly Account[],
  envAccount: string | undefined,
  configDir: string | undefined,
  home: string,
): Account | undefined {
  const named = accounts.find(account => account.name === envAccount)
  if (named !== undefined) return named
  const dir = (configDir ?? `${home}/.claude`).replace(/\/+$/, '')
  return accounts.find(account => account.dir === dir)
}

// Where an account's login record lives: ~/.claude's in ~/.claude.json.
export function configFileOf(account: Account, home: string): string {
  return account.dir === `${home}/.claude` ? `${home}/.claude.json` : `${account.dir}/.claude.json`
}

export function emailIn(configText: string): string | undefined {
  try {
    const email = JSON.parse(configText)?.oauthAccount?.emailAddress
    return typeof email === 'string' && email !== '' ? email : undefined
  } catch {
    // A config file mid-write reads as not signed in; the next /account reads it again.
    return undefined
  }
}

export function formatList(
  rows: readonly { account: Account; email: string | undefined }[],
  current: string | undefined,
  defaultName: string | undefined,
): string {
  const lines = rows.map(({ account, email }) => {
    const marks = [
      account.name === current ? 'this session' : '',
      account.name === defaultName ? 'new sessions' : '',
    ].filter(mark => mark !== '')
    const note = marks.length === 0 ? '' : `  ← ${marks.join(', ')}`
    return `${account.name.padEnd(8)} ${(email ?? '(not signed in)').padEnd(28)}${note}`
  })
  return [...lines, '', USAGE].join('\n')
}
