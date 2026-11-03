import { parseRef } from './ids'
import { type Block, type Index, SYNTHETIC_MODEL, type Unit, assistantText, blockText, isQueuedCommand, promptText } from './model'
import { isProtected } from './protected'
import type { Row } from './rows'
import { PRUNED_COMPRESS_SUMMARY } from './strategies'

export type Entry = { startId: string; endId: string; summary: string; save?: string[] }
export type CompressArgs = { topic: string; content: Entry[] }
export type CompressConfig = {
  protectedTools: readonly string[]
  protectedFilePatterns: readonly string[]
}
/** A validated range: rows `s..e` (inclusive, widened to whole messages and whole tool calls) become `finalSummary`. */
export type Plan = {
  index: number
  entry: Entry
  s: number
  e: number
  messageCount: number
  finalSummary: string
  /** The blocks inside the range, whose summaries `finalSummary` replaces. */
  consumedBlockIds: number[]
  /** Tool outputs the model chose to keep out of the context, written to `path` at the fork. */
  saves: { path: string; text: string }[]
}

/** The model's arguments are wrong in a way it can fix and retry. */
export class PlanError extends Error {}

/** Part of the message for an ID that is well-formed but not (yet) tagged in the conversation; the caller may retry it after the next tag lands. */
export const UNKNOWN_ID = 'is not in the current context'

/** Heads the part of a block carried verbatim into every block that later replaces it: user messages, recent model messages, protected outputs,
    saved-output paths. */
export const KEPT_HEADER = '[Kept verbatim]'
const KEPT_SPLIT = /^\[Kept verbatim\]$/m
const LABEL_CHARS = 80
// what a block keeps of the model's own text: its last messages, and the answers of the last turns, which the user may refer back to
export const RECENT_AI_MESSAGES = 10
export const ANSWERED_TURNS = 2
const USER_HEAD = '### User message'
const AI_HEAD = '### AI message'
const ITEM_HEAD = '### (?:User message|AI message|Tool: |Saved output: )'
// a kept part splits into items at their heads; a line inside an item that reads as a head is escaped, so it cannot split one
const ITEM_SPLIT = new RegExp(`\\n\\n(?=${ITEM_HEAD})`)
const HEAD_LINE = new RegExp(`^${ITEM_HEAD}`, 'gm')
// a background agent's launch notice that blocks made before launches were skipped still carry
const LAUNCH_ITEM = /^### Tool: \S+\nAsync agent launched successfully\./
const BLOCK_HEAD = /^\s*\[Compressed conversation(?: section)?(?: b\d+)?\]\s*/i
const BLOCK_TAIL = /\s*<dcp-message-id>b\d+<\/dcp-message-id>\s*$/i

const bullets = (issues: string[]) => (issues.length === 1 ? issues[0] : issues.map(issue => `- ${issue}`).join('\n'))
const unwrap = (block: Block) => block.summary.replace(BLOCK_HEAD, '').replace(BLOCK_TAIL, '').trim()
const item = (head: string, body: string) => `${head}\n${body.replace(HEAD_LINE, '\\$&')}`

/** One item of what a block keeps or a range may keep, at the row it came from: a user message, a model message, or another kept item. */
type Kept = { kind: 'user' | 'ai' | 'other'; row: number; text: string }
const kindOf = (text: string): Kept['kind'] => (text.startsWith(`${USER_HEAD}\n`) ? 'user' : text.startsWith(`${AI_HEAD}\n`) ? 'ai' : 'other')

/** The items a block carries verbatim: those after its first KEPT_HEADER line; a block without one carries none. */
function keptOf(block: Block): Kept[] {
  const part = unwrap(block).split(KEPT_SPLIT).slice(1).join(KEPT_HEADER).trim()
  return part
    .split(ITEM_SPLIT)
    .map(text => text.trim())
    .filter(text => text !== '' && !LAUNCH_ITEM.test(text))
    .map(text => ({ kind: kindOf(text), row: block.row, text }))
}

/** The text of a message the user typed: a prompt, or one queued while a turn ran. Hook feedback, task notifications, subagent and plugin prompts are not. */
export function humanText(row: Row): string | null {
  if (isQueuedCommand(row)) return row.attachment.origin?.kind === 'human' ? blockText(row.attachment.prompt) : null
  return row.origin?.kind === 'human' ? promptText(row) : null
}

function checkArgs(args: CompressArgs): void {
  if (typeof args.topic !== 'string' || args.topic.trim() === '') throw new PlanError('topic must be a non-empty string')
  if (!Array.isArray(args.content) || args.content.length === 0) throw new PlanError('content must be a non-empty array')
  args.content.forEach((entry, i) => {
    for (const field of ['startId', 'endId', 'summary'] as const)
      if (typeof entry?.[field] !== 'string' || entry[field].trim() === '') throw new PlanError(`content[${i}].${field} must be a non-empty string`)
    if (entry.summary.includes(KEPT_HEADER)) throw new PlanError(`content[${i}].summary must not contain ${KEPT_HEADER}: the environment adds that part`)
    if (entry.summary.includes(PRUNED_COMPRESS_SUMMARY)) throw new PlanError(`content[${i}].summary must not contain ${PRUNED_COMPRESS_SUMMARY}: that marks a pruned earlier call; write the summary of this range`)
    if (entry.save !== undefined && (!Array.isArray(entry.save) || !entry.save.every(ref => typeof ref === 'string'))) throw new PlanError(`content[${i}].save must be an array of tool-output IDs`)
  })
}

type Edge = { ref: string; unit: Unit }

function locate(idx: Index, entry: Entry): { from: Edge; to: Edge } {
  const issues: string[] = []
  const edge = (name: 'startId' | 'endId'): Edge | undefined => {
    const parsed = parseRef(entry[name])
    if (!parsed) return void issues.push(`${name} "${entry[name]}" is not an ID (use mNNNN or bN)`)
    const unit = idx.units.get(parsed.ref)
    if (!unit) return void issues.push(`${name} ${parsed.ref} ${UNKNOWN_ID}; use an ID you can see`)
    return { ref: parsed.ref, unit }
  }
  const [from, to] = [edge('startId'), edge('endId')]
  if (!from || !to) throw new PlanError(bullets(issues))
  if (from.unit.start > to.unit.start) throw new PlanError(`startId ${from.ref} comes after endId ${to.ref}`)
  return { from, to }
}

const sameMessage = (a: Row, b: Row) => a.type === 'assistant' && b.type === 'assistant' && a.message?.id === b.message?.id

function messageSpan(rows: readonly Row[], i: number): [number, number] {
  let [first, last] = [i, i]
  while (first > 0 && sameMessage(rows[first - 1], rows[i])) first--
  while (last + 1 < rows.length && sameMessage(rows[last + 1], rows[i])) last++
  return [first, last]
}

/** Grows `s..e` until it holds whole assistant messages and, for every tool call touching it, the call, its result and the result's id tag. */
function closeRange(rows: readonly Row[], idx: Index, s: number, e: number): [number, number] {
  const calls = idx.calls
    .filter(c => c.resultRow !== undefined)
    .map(c => {
      const tagged = rows[c.resultRow! + 1]?.attachment?.toolUseID === `${c.id}-context`
      return { first: messageSpan(rows, c.useRow)[0], uses: c.useRow, result: c.resultRow!, last: c.resultRow! + (tagged ? 1 : 0) }
    })
  for (;;) {
    let [lo, hi] = [messageSpan(rows, s)[0], messageSpan(rows, e)[1]]
    for (const c of calls) {
      const touches = (row: number) => row >= lo && row <= hi
      if (touches(c.uses) || touches(c.result)) [lo, hi] = [Math.min(lo, c.first), Math.max(hi, c.last)]
    }
    if (lo === s && hi === e) return [s, e]
    ;[s, e] = [lo, hi]
  }
}

type Span = { index: number; entry: Entry; s: number; e: number }

export function assertDisjoint(spans: readonly Span[]): void {
  const ordered = [...spans].sort((a, b) => a.s - b.s || a.e - b.e || a.index - b.index)
  const issues: string[] = []
  ordered.slice(1).forEach((b, i) => {
    const a = ordered[i]
    if (b.s <= a.e)
      issues.push(`content[${a.index}] (${a.entry.startId}..${a.entry.endId}) overlaps content[${b.index}] (${b.entry.startId}..${b.entry.endId}); ranges in one call cannot overlap`)
  })
  if (issues.length > 0) throw new PlanError(bullets(issues))
}

/** A range queued for the next fork: rows `s..e` of the transcript it was planned on. */
export type Queued = { entry: Entry; s: number; e: number }

const span = (q: { entry: Entry }) => `${q.entry.startId}..${q.entry.endId}`

/** Folds a call's ranges into those queued by earlier calls and not yet applied: a range inside a queued one adds nothing, a range
    covering queued ones (or the same rows, with a new summary) replaces them, and a partial overlap is refused. `notes` tells the model what was skipped or replaced. */
export function mergeQueue(queued: readonly Queued[], fresh: readonly Span[]): { queue: Queued[]; notes: string[] } {
  let queue = [...queued]
  const notes: string[] = []
  for (const p of fresh) {
    const outer = queue.find(q => q.s <= p.s && p.e <= q.e && !(q.s === p.s && q.e === p.e))
    if (outer) {
      notes.push(`${span(p)} skipped: it lies inside ${span(outer)}, already queued`)
      continue
    }
    const inner = queue.filter(q => p.s <= q.s && q.e <= p.e)
    const partial = queue.find(q => !inner.includes(q) && q.s <= p.e && p.s <= q.e)
    if (partial)
      throw new PlanError(`content[${p.index}] (${span(p)}) partly overlaps ${span(partial)}, queued by an earlier call and not applied yet. Cover all of ${span(partial)} to replace it, or none of it.`)
    notes.push(...inner.map(q => `${span(p)} replaces ${span(q)}, queued earlier`))
    queue = [...queue.filter(q => !inner.includes(q)), { entry: p.entry, s: p.s, e: p.e }]
  }
  return { queue, notes }
}

function countMessages(rows: readonly Row[], s: number, e: number): number {
  const seen = new Set<string>()
  rows.slice(s, e + 1).forEach((row, i) => {
    if (row.type === 'assistant') seen.add(`a${row.message?.id}`)
    else if (promptText(row) !== null) seen.add(`u${s + i}`)
  })
  return seen.size
}

const label = (input: Record<string, any>) => String(Object.values(input).find(v => typeof v === 'string') ?? '').replace(/\s+/g, ' ').slice(0, LABEL_CHARS)

/** The outputs `save` names, each a tool output inside rows `s..e` that compression would otherwise drop. */
function savesOf(idx: Index, entry: Entry, index: number, s: number, e: number, config: CompressConfig, outputsDir: string) {
  return (entry.save ?? []).map(raw => {
    const call = idx.units.get(parseRef(raw)?.ref ?? '')?.call
    if (!call || call.useRow < s || call.resultRow! > e || call.isError || isProtected(call.name, call.input, config.protectedTools, config.protectedFilePatterns))
      throw new PlanError(`content[${index}].save: ${raw} is not the ID of a successful, unprotected tool output inside ${entry.startId}..${entry.endId}`)
    return { call, path: `${outputsDir}/${call.id}.txt` }
  })
}

/** Every item a block keeps and every message, in conversation order: the items of each block, what the user typed, and the model's text,
    one item per assistant message (its text rows share the message id); Claude Code's own placeholder answers are not the model's. */
function conversation(rows: readonly Row[], idx: Index): Kept[] {
  const blocks = new Map([...idx.blocks.values()].map(block => [block.row, block]))
  const items: Kept[] = []
  const said = new Map<string, Kept>()
  rows.forEach((row, i) => {
    const block = blocks.get(i)
    if (block) return items.push(...keptOf(block))
    const typed = humanText(row)
    if (typed !== null) return items.push({ kind: 'user', row: i, text: item(USER_HEAD, typed) })
    if (row.type !== 'assistant' || row.message?.model === SYNTHETIC_MODEL || assistantText(row).trim() === '') return
    const prior = said.get(row.message.id)
    if (prior) prior.text += assistantText(row)
    else {
      const message: Kept = { kind: 'ai', row: i, text: assistantText(row) }
      said.set(row.message.id, message)
      items.push(message)
    }
  })
  for (const message of said.values()) message.text = item(AI_HEAD, message.text.trim())

  return items
}

/** The model messages a range keeps: the last RECENT_AI_MESSAGES, and the answers of the last ANSWERED_TURNS turns, a turn's answer being its last
    model message before the user's next message. */
function recentAi(items: readonly Kept[]): Set<Kept> {
  const messages = items.filter(k => k.kind !== 'other')
  const answers = messages.filter((k, i) => k.kind === 'ai' && messages[i + 1]?.kind !== 'ai')

  return new Set([...messages.filter(k => k.kind === 'ai').slice(-RECENT_AI_MESSAGES), ...answers.slice(-ANSWERED_TURNS)])
}

/** What the range keeps verbatim, in conversation order: kept items of blocks inside, user messages, recent model messages, protected outputs,
    saved-output paths. A model message a block kept leaves once a range covering that block finds it no longer recent. */
function keptItems(rows: readonly Row[], idx: Index, s: number, e: number, config: CompressConfig, saved: ReturnType<typeof savesOf>): string[] {
  const all = conversation(rows, idx)
  const recent = recentAi(all)
  const items: [number, string][] = all.filter(k => k.row >= s && k.row <= e && (k.kind !== 'ai' || recent.has(k))).map(k => [k.row, k.text])
  for (const c of idx.calls)
    if (c.useRow >= s && c.useRow <= e && c.resultRow !== undefined && !c.isError && c.resultText && !c.isLaunch && isProtected(c.name, c.input, config.protectedTools, config.protectedFilePatterns))
      items.push([c.useRow, item(`### Tool: ${c.name}`, c.resultText)])
  for (const { call, path } of saved) items.push([call.useRow, `### Saved output: ${call.name} ${label(call.input)}\n${path}`])
  return items.sort((a, b) => a[0] - b[0]).map(([, text]) => text)
}

/** `outputsDir` is where the outputs an entry saves are written. */
export function planCompression(rows: readonly Row[], idx: Index, args: CompressArgs, config: CompressConfig, outputsDir: string): Plan[] {
  checkArgs(args)
  const located = args.content.map((raw, index) => {
    const entry = { ...raw, startId: raw.startId.trim(), endId: raw.endId.trim() }
    const { from, to } = locate(idx, entry)
    const [s, e] = closeRange(rows, idx, from.unit.start, to.unit.end)
    return { index, entry, s, e }
  })
  assertDisjoint(located)

  return located.map(({ index, entry, s, e }) => {
    const inside = new Map([...idx.blocks].filter(([, b]) => b.row >= s && b.row <= e).sort((a, b) => a[1].row - b[1].row))
    const cited = [...inside.keys()].filter(id => new RegExp(`\\(b${id}\\)`).test(entry.summary))
    if (cited.length > 0) throw new PlanError(`content[${index}].summary cites ${cited.map(id => `(b${id})`).join(', ')}, which this range replaces: write what is still needed of them instead`)
    const saved = savesOf(idx, entry, index, s, e, config, outputsDir)
    const kept = keptItems(rows, idx, s, e, config, saved)
    const finalSummary = [entry.summary.trim(), ...(kept.length > 0 ? [`${KEPT_HEADER}\n${kept.join('\n\n')}`] : [])].join('\n\n')
    return { index, entry, s, e, messageCount: countMessages(rows, s, e), finalSummary, consumedBlockIds: [...inside.keys()], saves: saved.map(({ call, path }) => ({ path, text: call.resultText })) }
  })
}
