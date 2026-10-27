import { blockRef } from './ids'
import { COMPRESSED_BLOCK_HEADER, type Block, type Index, type ToolCall, type Unit, isQueuedCommand, promptText } from './model'
import type { Row } from './rows'
import type { TurnUsage } from './stats'

const LISTED_BLOCKS = 8
const LISTED_MESSAGES = 8
const SYNTHETIC_MODEL = '<synthetic>' // Claude Code's own placeholder answers carry no usage

export const formatTokens = (tokens: number) =>
  tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`

export const approxTokens = (tokens: number) => `~${formatTokens(tokens)}`

const hasText = (row: Row) => row.type === 'user' || row.type === 'assistant'

const rowLength = (row: Row) => (hasText(row) ? JSON.stringify(row.message?.content).length : 0)

/** What a conversation weighs before it is turned into tokens: the serialized content of its messages. */
export const rowChars = (rows: readonly Row[]) => rows.reduce((sum, row) => sum + rowLength(row), 0)

/** The input side of one request. */
export const inputTokens = (usage: TurnUsage) => usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

type Request = { first: number; usage: TurnUsage }

/** The model's answered requests in file order, with the counts the API reported: one per assistant message id, which may span rows. */
export function answeredRequests(rows: readonly Row[]): Request[] {
  const found: Request[] = []
  for (let i = 0; i < rows.length; i++) {
    const message = rows[i].type === 'assistant' ? rows[i].message : undefined
    if (message?.usage === undefined || message.model === SYNTHETIC_MODEL) continue
    let last = i
    while (rows[last + 1]?.type === 'assistant' && rows[last + 1].message?.id === message.id) last++
    found.push({ first: i, usage: rows[last].message.usage })
    i = last
  }

  return found
}

/** Tokens per character of this conversation, measured on the API's own counts: from one request to the next, the input grows by
    what the answer and the rows after it weigh. Pairs that do not grow past that answer (the first request after a fork starts
    over) or that straddle a compressed block are left out. Code and JSON take more tokens per character than prose, so the rate
    is measured per conversation, never assumed. Undefined while no pair of requests qualifies, as in a conversation of one request. */
export function tokensPerChar(rows: readonly Row[]): number | undefined {
  const requests = answeredRequests(rows)
  let [tokens, chars] = [0, 0]
  for (let i = 1; i < requests.length; i++) {
    const [prev, next] = [requests[i - 1], requests[i]]
    const span = rows.slice(prev.first, next.first)
    const added = inputTokens(next.usage) - inputTokens(prev.usage)
    if (added <= prev.usage.output_tokens || span.some(row => promptText(row)?.startsWith(COMPRESSED_BLOCK_HEADER))) continue
    tokens += added
    chars += rowChars(span)
  }

  return chars === 0 ? undefined : tokens / chars
}

export const tokensOf = (chars: number, scale: number) => Math.round(chars * scale)

/** A limit is a token count ("100000") or a percent of the model window ("80%"). */
export function resolveLimit(limit: string, window: number): number {
  const text = limit.trim()
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(text)
  if (percent) return Math.round((Math.min(100, Math.round(Number(percent[1]))) / 100) * window)
  if (/^\d+$/.test(text)) return Number(text)
  throw new Error(`Invalid context limit "${limit}": expected a token count like 100000 or a percent like 80%`)
}

export function blockReport(blocks: ReadonlyMap<number, Block>, scale: number): string {
  const ids = [...blocks.keys()].sort((a, b) => a - b)
  const head = `Compressed blocks: ${ids.length} (${ids.length > 0 ? ids.map(blockRef).join(', ') : 'none'})`
  if (ids.length === 0) return head
  const sizes = ids.map(id => ({ id, tokens: tokensOf(blocks.get(id)!.summary.length, scale) })).sort((a, b) => b.tokens - a.tokens)
  const listed = sizes.slice(0, LISTED_BLOCKS).map(({ id, tokens }) => `  - ${blockRef(id)}: ${approxTokens(tokens)}`)
  if (sizes.length > LISTED_BLOCKS) listed.push(`  - ... +${sizes.length - LISTED_BLOCKS} smaller`)
  return [
    head,
    `Block summaries cost tokens too: ${approxTokens(sizes.reduce((sum, b) => sum + b.tokens, 0))} in total. Largest:`,
    ...listed,
    'In order of preference:',
    '1. Drop ranges you no longer need. A range removes their raw text and tool outputs entirely.',
    `2. Merge blocks only if they must live to the end of the session: compress a range over them (e.g. ${blockRef(1)}..${blockRef(8)}) citing each as (bN) once. Merging is lossy and permanent.`,
    '3. Leave anything uncertain alone.',
  ].join('\n')
}

const LISTED_TURNS = 15
const LABEL_CHARS = 48

const oneLine = (text: string) => {
  const flat = text.replace(/<dcp-message-id>[^<]*<\/dcp-message-id>/g, '').replace(/\s+/g, ' ').trim()
  return flat.length > LABEL_CHARS ? `${flat.slice(0, LABEL_CHARS - 1)}…` : flat
}

/** A few words on what a tool call did, from its arguments: the description the model gave it, else the file, pattern or command. */
export function callLabel(call: ToolCall): string {
  const { description, file_path, path, pattern, command, url, query, prompt } = call.input
  const detail = [description, file_path, pattern, command, url, query, path, prompt].find(v => typeof v === 'string' && v.trim() !== '')
  return detail === undefined ? call.name : `${call.name}: ${oneLine(detail)}`
}

type Sized = { ref: string; unit: Unit; chars: number }

/** Each m-unit with the characters of the rows it covers; a row two units cover (parallel calls of one message) counts for the first to end. */
function sizedUnits(rows: readonly Row[], idx: Index): Sized[] {
  const owned = new Set<number>()
  return [...idx.units]
    .filter(([ref]) => ref.startsWith('m'))
    .sort((a, b) => a[1].end - b[1].end)
    .map(([ref, unit]) => {
      let chars = 0
      for (let i = unit.start; i <= unit.end; i++)
        if (!owned.has(i)) {
          owned.add(i)
          chars += rowLength(rows[i])
        }
      return { ref, unit, chars }
    })
}

function turnLabel(rows: readonly Row[], unit: Unit): string {
  const row = rows[unit.start]
  return isQueuedCommand(row) ? 'task notification' : `"${oneLine(promptText(row) ?? '')}"`
}

/** The uncompressed history as ranges a compress call can take whole: one per user turn, oldest first, with its size and what it
    holds; then the largest single messages. A compressed block ends a range, so no listed range spans one. */
export function historyReport(rows: readonly Row[], idx: Index, scale: number): string {
  const blockRows = [...idx.blocks.values()].map(b => b.row)
  type Turn = { first: string; last: string; label: string; chars: number; tools: Map<string, number> }
  const turns: Turn[] = []
  let end = -1
  const sized = sizedUnits(rows, idx)
  for (const { ref, unit, chars } of sized) {
    const current = turns.at(-1)
    if (current === undefined || unit.call === undefined || blockRows.some(b => b > end && b < unit.start))
      turns.push({ first: ref, last: ref, label: unit.call === undefined ? turnLabel(rows, unit) : '(continued)', chars, tools: new Map() })
    else Object.assign(current, { last: ref, chars: current.chars + chars })
    if (unit.call) turns.at(-1)!.tools.set(unit.call.name, (turns.at(-1)!.tools.get(unit.call.name) ?? 0) + 1)
    end = unit.end
  }
  if (turns.length === 0) return ''
  const kept = new Set([...turns].sort((a, b) => b.chars - a.chars).slice(0, LISTED_TURNS))
  const left = turns.filter(t => !kept.has(t))
  const line = (t: Turn) => {
    const tools = [...t.tools].map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join(', ')
    return `- ${t.first === t.last ? t.first : `${t.first}..${t.last}`} ${approxTokens(tokensOf(t.chars, scale))} ${t.label}${tools ? `; ${tools}` : ''}`
  }
  const largest = [...sized].sort((a, b) => b.chars - a.chars).slice(0, LISTED_MESSAGES).filter(m => m.chars > 0)
  return [
    'Uncompressed history by user turn, oldest first (range, size, prompt; tools used). Each range can be passed to a compress call as is:',
    ...turns.filter(t => kept.has(t)).map(line),
    ...(left.length > 0 ? [`- ... ${left.length} smaller turns, ${approxTokens(tokensOf(left.reduce((n, t) => n + t.chars, 0), scale))} together`] : []),
    '',
    'Largest single messages (a range over one drops its text and tool output entirely):',
    ...largest.map(m => `- ${m.ref} ${approxTokens(tokensOf(m.chars, scale))} ${m.unit.call ? callLabel(m.unit.call) : turnLabel(rows, m.unit)}`),
  ].join('\n')
}
