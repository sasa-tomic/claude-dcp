import { parseRef } from './ids'
import { type Block, type Index, type Unit, promptText } from './model'
import { isProtected } from './protected'
import type { Row } from './rows'

export type Entry = { startId: string; endId: string; summary: string }
export type CompressArgs = { topic: string; content: Entry[] }
export type CompressConfig = {
  protectedTools: readonly string[]
  protectedFilePatterns: readonly string[]
  protectUserMessages: boolean
  protectTags: boolean
}
/** A validated range: rows `s..e` (inclusive, widened to whole messages and whole tool calls) become `finalSummary`. */
export type Plan = {
  index: number
  entry: Entry
  s: number
  e: number
  messageCount: number
  finalSummary: string
  consumedBlockIds: number[]
}

/** The model's arguments are wrong in a way it can fix and retry. */
export class PlanError extends Error {}

/** Part of the message for an ID that is well-formed but not (yet) tagged in the conversation; the caller may retry it after the next tag lands. */
export const UNKNOWN_ID = 'is not in the current context'

const PLACEHOLDER = /\(b(\d+)\)/gi
const BLOCK_HEAD = /^\s*\[Compressed conversation(?: section)?(?: b\d+)?\]\s*/i
const BLOCK_TAIL = /\s*<dcp-message-id>b\d+<\/dcp-message-id>\s*$/i
const PROTECT_TAG = /<protect>([\s\S]*?)<\/protect>/gi

const bullets = (issues: string[]) => (issues.length === 1 ? issues[0] : issues.map(issue => `- ${issue}`).join('\n'))
const section = (title: string, items: string[]) => (items.length > 0 ? `\n\n${title}${items.map(item => `\n${item}`).join('')}` : '')
const unwrap = (block: Block) => block.summary.replace(BLOCK_HEAD, '').replace(BLOCK_TAIL, '').trim()

function checkArgs(args: CompressArgs): void {
  if (typeof args.topic !== 'string' || args.topic.trim() === '') throw new PlanError('topic must be a non-empty string')
  if (!Array.isArray(args.content) || args.content.length === 0) throw new PlanError('content must be a non-empty array')
  args.content.forEach((entry, i) => {
    for (const field of ['startId', 'endId', 'summary'] as const)
      if (typeof entry?.[field] !== 'string' || entry[field].trim() === '') throw new PlanError(`content[${i}].${field} must be a non-empty string`)
  })
}

type Edge = { ref: string; block?: number; unit: Unit }

function locate(idx: Index, entry: Entry): { from: Edge; to: Edge } {
  const issues: string[] = []
  const edge = (name: 'startId' | 'endId'): Edge | undefined => {
    const parsed = parseRef(entry[name])
    if (!parsed) return void issues.push(`${name} "${entry[name]}" is not an ID (use mNNNN or bN)`)
    const unit = idx.units.get(parsed.ref)
    if (!unit) return void issues.push(`${name} ${parsed.ref} ${UNKNOWN_ID}; use an ID you can see`)
    return { ref: parsed.ref, block: parsed.block, unit }
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

/** Swaps `(bN)` placeholders for the block they name. Only the first use of a block that lies inside the range counts; any other stays as written. */
function expandBlocks(summary: string, inside: ReadonlyMap<number, Block>, from: Edge, to: Edge) {
  const used: number[] = []
  let text = summary.replace(PLACEHOLDER, (whole, n) => {
    const id = Number(n)
    const block = inside.get(id)
    if (!block || used.includes(id)) return whole
    used.push(id)
    return unwrap(block)
  })
  const prepend: string[] = []
  const append: string[] = []
  for (const [edge, side] of [[from, prepend], [to, append]] as const)
    if (edge.block !== undefined && !used.includes(edge.block)) {
      used.push(edge.block)
      side.push(unwrap(inside.get(edge.block)!))
    }
  text = [...prepend, text.trim(), ...append].join('\n\n')
  const rest = [...inside].filter(([id]) => !used.includes(id))
  text += section('Earlier summaries inside this range:', rest.map(([id, block]) => `### (b${id})\n${unwrap(block)}`))
  return { text, consumed: [...used, ...rest.map(([id]) => id)] }
}

function keepVerbatim(rows: readonly Row[], idx: Index, s: number, e: number, config: CompressConfig): string {
  const prompts = rows
    .slice(s, e + 1)
    .map(promptText)
    .filter((text): text is string => text !== null && !text.startsWith('[Compressed conversation'))
  const tagged = config.protectTags ? prompts.flatMap(text => [...text.matchAll(PROTECT_TAG)].map(m => m[1].trim()).filter(Boolean)) : []
  const outputs = idx.calls
    .filter(c => c.useRow >= s && c.useRow <= e && c.resultRow !== undefined && !c.isError && c.resultText)
    .filter(c => isProtected(c.name, c.input, config.protectedTools, config.protectedFilePatterns))
    .map(c => `### Tool: ${c.name}\n${c.resultText}`)
  return (
    section('User messages in this range, verbatim:', config.protectUserMessages ? prompts : []) +
    section('Protected prompt text, verbatim:', tagged) +
    section('Protected tool outputs:', outputs)
  )
}

export function planCompression(rows: readonly Row[], idx: Index, args: CompressArgs, config: CompressConfig): Plan[] {
  checkArgs(args)
  const located = args.content.map((raw, index) => {
    const entry = { startId: raw.startId.trim(), endId: raw.endId.trim(), summary: raw.summary }
    const { from, to } = locate(idx, entry)
    const [s, e] = closeRange(rows, idx, from.unit.start, to.unit.end)
    return { index, entry, from, to, s, e }
  })
  assertDisjoint(located)

  return located.map(({ index, entry, from, to, s, e }) => {
    const inside = new Map([...idx.blocks].filter(([, b]) => b.row >= s && b.row <= e).sort((a, b) => a[1].row - b[1].row))
    const { text, consumed } = expandBlocks(entry.summary, inside, from, to)
    return { index, entry, s, e, messageCount: countMessages(rows, s, e), finalSummary: text + keepVerbatim(rows, idx, s, e, config), consumedBlockIds: consumed }
  })
}
