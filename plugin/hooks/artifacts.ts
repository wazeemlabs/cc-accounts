// The artifacts a conversation published, and the account each belongs to.
//
// An artifact belongs to the claude.ai account that published it: a new one
// "is visible only to you", and another account opens or republishes it only
// after its owner shares it from the page's Share control in a browser
// (code.claude.com/docs/en/artifacts, read 2026-11-18). Claude Code offers no
// call that shares one and none that moves one to another account. So a
// conversation moved to another account cannot read, watch or republish what
// it published before the move, and was told to start those watches again
// (2026-11-18: both of a session's artifacts answered "no such artifact for
// this account" after a move from cto to levoro).
//
// What the plugin can do is know: each publish is noted with its link, its
// source file and the account that owns it, in a file every account's
// sessions share. A move then says which artifacts stayed behind and what
// keeps each one, and an Artifact call on one of them carries the same words.
import type { EngineInterface } from 'claude-code'
import { describeError, run, writeAtomic } from './context'

export type Published = { url: string; file: string; account: string }

// A claude.ai artifact link, as the Artifact tool gives and takes it.
const LINK = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[0-9a-zA-Z-]+$/
const LINK_IN_TEXT = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[0-9a-zA-Z-]+/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The artifact an Artifact call published as its owner, read from the call's
// input and result. A publish to someone else's artifact (`owned: false`)
// and every other action are not this account's to note.
export function published(tool: string, input: Record<string, unknown>, result: unknown, account: string): Published | undefined {
  if (tool !== 'Artifact' || !isObject(result)) return undefined
  if (input.action !== undefined && input.action !== 'publish') return undefined
  if (typeof result.url !== 'string' || !LINK.test(result.url) || result.owned === false) return undefined
  const file = typeof input.file_path === 'string' ? input.file_path : ''
  return { url: result.url, file, account }
}

// The link a call names (its `url`), or the one in a watch's description.
export function linkIn(text: unknown): string | undefined {
  return typeof text === 'string' ? LINK_IN_TEXT.exec(text)?.[0] : undefined
}

// `notes` with `note` in place of any earlier note of the same artifact.
export function withNote(notes: readonly Published[], note: Published): Published[] {
  return [...notes.filter(old => old.url !== note.url), note]
}

// undefined: the file is not a list of notes (a partial write, another
// version's).
export function parseNotes(text: string): Published[] | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Not JSON: the caller reports it and notes afresh.
    return undefined
  }
  if (!Array.isArray(value)) return undefined
  const notes: Published[] = []
  for (const row of value) {
    if (!isObject(row) || typeof row.url !== 'string' || !LINK.test(row.url)) return undefined
    if (typeof row.file !== 'string' || typeof row.account !== 'string' || row.account === '') return undefined
    notes.push({ url: row.url, file: row.file, account: row.account })
  }
  return notes
}

// The artifacts that belong to an account other than `account`.
export function elsewhere(notes: readonly Published[], account: string): Published[] {
  return notes.filter(note => note.account !== account)
}

function nameNote(note: Published): string {
  return `${note.url} (owned by ${note.account}${note.file ? `, source ${note.file}` : ''})`
}

const KEEPS =
  'An artifact belongs to the account that published it, and Claude Code cannot share or move one. ' +
  'To use one here, read it first (Artifact action "read"): if that answers, it was shared with this account, and it can be watched, ' +
  'and republished at the same link where the read says "writer". If the read says there is no such artifact, do not try again: ' +
  'tell the person that its owner must open the link on claude.ai, press Share and give the whole organization edit access (or add this account as an editor) to keep the link, ' +
  'or, if they would rather have a new link, publish its source file as a new artifact.'

// What a conversation moved to `to` is told about the artifacts it left on
// other accounts; undefined with none.
export function artifactsText(notes: readonly Published[], to: string): string | undefined {
  const left = elsewhere(notes, to)
  if (left.length === 0) return undefined
  const names = left.map(nameNote).join(', ')
  return `This conversation published ${left.length === 1 ? 'this artifact' : 'these artifacts'} on another account, ` +
    `and the ${to} account does not own ${left.length === 1 ? 'it' : 'them'}: ${names}. ${KEEPS}`
}

// What an Artifact call on another account's artifact reads after its result;
// undefined for a call that names none of them.
export function callContext(input: Record<string, unknown>, notes: readonly Published[], account: string): string | undefined {
  const url = linkIn(input.url)
  const note = url === undefined ? undefined : elsewhere(notes, account).find(left => left.url === url)
  if (note === undefined) return undefined
  return `cc-accounts: this conversation published ${nameNote(note)}, and it now runs on the ${account} account. ${KEEPS}`
}

// The background work whose description is a watch of one of `left`: a move
// cannot start it again on the new account, so it is not asked to.
export function isLostWatch(description: string, left: readonly Published[]): boolean {
  const url = linkIn(description)
  return url !== undefined && left.some(note => note.url === url)
}

// The answer to an Artifact call, after the plugin has noted what it
// published and added, for another account's artifact, who owns it. Never
// rejects: the call has gone through, and an error here would run it again.
export async function afterCall<Answer extends { result?: unknown; deny?: string; context?: readonly string[] }>(
  $: EngineInterface,
  root: string,
  account: string,
  input: Record<string, unknown>,
  answer: Answer,
): Promise<Answer> {
  try {
    const sessionId = await $.session.id()
    const note = published('Artifact', input, answer.result, account)
    if (note !== undefined) await saveNote($, root, sessionId, note)
    if (answer.deny !== undefined) return answer
    const said = callContext(input, await readNotes($, root, sessionId), account)
    return said === undefined ? answer : { ...answer, context: [...(answer.context ?? []), said] }
  } catch (error) {
    $.ui.log(`cc-accounts: could not note an artifact (${describeError(error)}).`)
    return answer
  }
}

export function notesFile(root: string, sessionId: string): string {
  return `${root}/artifacts/${sessionId}.json`
}

// The notes of `sessionId`; none where no artifact was noted or the file is
// not one (reported, and the next publish writes it afresh).
export async function readNotes($: EngineInterface, root: string, sessionId: string): Promise<Published[]> {
  const file = notesFile(root, sessionId)
  if (!(await $.fs.exists(file))) return []
  const notes = parseNotes(await $.fs.read(file))
  if (notes === undefined) {
    $.ui.log(`cc-accounts: ${file} is not a list of artifacts; noting them afresh.`, { to: 'debug' })
    return []
  }
  return notes
}

export async function saveNote($: EngineInterface, root: string, sessionId: string, note: Published): Promise<void> {
  const made = await run($, ['mkdir', '-p', `${root}/artifacts`])
  if (made.exitCode !== 0) throw new Error(`could not make ${root}/artifacts: ${made.stderr.trim()}`)
  const notes = withNote(await readNotes($, root, sessionId), note)
  await writeAtomic($, notesFile(root, sessionId), `${JSON.stringify(notes, null, 1)}\n`)
}
