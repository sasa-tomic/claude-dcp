import { blockRef } from './ids'
import { COMPRESSED_BLOCK_HEADER, type Block, type Index, promptText } from './model'
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

export function messageReport(rows: readonly Row[], idx: Index, scale: number): string {
  const sized = [...idx.units]
    .filter(([ref]) => ref.startsWith('m'))
    .map(([ref, unit]) => {
      const span = rows.slice(unit.start, unit.end + 1)
      const chars = rowChars(span)
      const results = span.reduce((sum, row) => sum + (Array.isArray(row.message?.content) ? row.message.content.filter((b: Row) => b.type === 'tool_result').length : 0), 0)
      return { ref, role: promptText(rows[unit.start]) !== null ? 'user' : 'assistant', tokens: tokensOf(chars, scale), results }
    })
    .filter(m => m.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, LISTED_MESSAGES)
  if (sized.length === 0) return ''
  return [
    'Largest uncompressed messages (drop candidates: a range over them removes their text and tool outputs entirely):',
    ...sized.map(m => `- ${m.ref} ${m.role} ${approxTokens(m.tokens)}${m.results > 0 ? `, ${m.results} tool output${m.results === 1 ? '' : 's'}` : ''}`),
  ].join('\n')
}
