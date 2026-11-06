// The account table cca keeps (accounts.tsv: name, tab, config dir) and what
// /account's arguments ask for. Pure: register.ts does the reading and writing.

export type Account = { name: string; dir: string }

export type Ask =
  | { kind: 'list' }
  | { kind: 'report' }
  | { kind: 'switch'; name: string; force: boolean }
  | { kind: 'default'; name: string }
  | { kind: 'priority'; weight: string | undefined; folder: string | undefined }
  | { kind: 'budget'; points: string | undefined; folder: string | undefined }
  | { kind: 'help' }

export const USAGE =
  'Usage: /account (list), /account <name> (switch this session once its work is done), ' +
  '/account <name> now (switch at once, stopping that work), /account default <name>, ' +
  '/account usage (what is free on every account, and where each project runs), ' +
  '/account priority [<weight> [<folder>]] (how much a project matters; this one by default), ' +
  '/account budget [<points a day> [<folder>]] (what a project may spend each UTC day; 0 removes it)'

export function parseTable(text: string): Account[] {
  return text
    .split('\n')
    .flatMap(line => {
      const [name, dir, ...rest] = line.split('\t')
      return name && dir && rest.length === 0 ? [{ name, dir }] : []
    })
}

export function parseAsk(args: string): Ask {
  const trimmed = args.trim()
  const words = trimmed.split(/\s+/).filter(word => word !== '')
  const [first, second, ...rest] = words
  if (first === undefined) return { kind: 'list' }
  // A folder may hold spaces: everything after the weight is the folder.
  if (first === 'priority' || first === 'budget') {
    const folder = second === undefined ? undefined : trimmed.slice(trimmed.indexOf(second) + second.length).trim()
    const rest = folder === '' ? undefined : folder
    return first === 'priority' ? { kind: 'priority', weight: second, folder: rest } : { kind: 'budget', points: second, folder: rest }
  }
  if (second === undefined) {
    if (first === 'default') return { kind: 'help' }
    return first === 'usage' ? { kind: 'report' } : { kind: 'switch', name: first, force: false }
  }
  if (rest.length > 0) return { kind: 'help' }
  if (first === 'default') return { kind: 'default', name: second }
  if (second === 'now') return { kind: 'switch', name: first, force: true }
  return { kind: 'help' }
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

// How big an account's plan is, in Max 5x plans: the rate-limit tier its
// login record names (`default_claude_max_5x` is 1, `..._max_20x` 4, Pro a
// fifth). Undefined for a tier this version cannot size.
export function unitsOfTier(tier: string): number | undefined {
  const max = /_max_([0-9]+)x$/.exec(tier)
  if (max !== null) return Number(max[1]) / 5
  return /(^|_)pro$/.test(tier) ? 1 / 5 : undefined
}

// The tier a login record names: the person's own, else the organization's.
export function tierIn(configText: string): string | undefined {
  try {
    const account = JSON.parse(configText)?.oauthAccount
    const tier = account?.userRateLimitTier ?? account?.organizationRateLimitTier
    return typeof tier === 'string' && tier !== '' ? tier : undefined
  } catch {
    // A config file mid-write: the plan reads as unknown and counts as one Max 5x.
    return undefined
  }
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

// `use`: the account's last usage reading (`5h 42%, week 10%`), '' for none.
// `start`: where new sessions start, the default unless it is low on room.
export function formatList(
  rows: readonly { account: Account; email: string | undefined; use: string }[],
  current: string | undefined,
  defaultName: string | undefined,
  start: string | undefined,
): string {
  const lines = rows.map(({ account, email, use }) => {
    const marks = [
      account.name === current ? 'this session' : '',
      account.name === start ? 'new sessions' : '',
      account.name === defaultName && defaultName !== start ? 'default, low on room' : '',
    ].filter(mark => mark !== '')
    const note = marks.length === 0 ? '' : `  ← ${marks.join(', ')}`
    return `${account.name.padEnd(8)} ${(email ?? '(not signed in)').padEnd(28)} ${(use || '-').padEnd(20)}${note}`
  })
  return [...lines, '', USAGE].join('\n')
}
