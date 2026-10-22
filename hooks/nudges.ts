import { blockRef } from './ids'
import { type Block, type Index, promptText } from './model'
import type { Row } from './rows'

const LISTED_BLOCKS = 8
const LISTED_MESSAGES = 8

export const estimateTokens = (text: string) => Math.round(text.length / 4)

export const formatTokens = (tokens: number) =>
  tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`

export const approxTokens = (tokens: number) => `~${formatTokens(tokens)}`

const hasText = (row: Row) => row.type === 'user' || row.type === 'assistant'

export const estimateRowsTokens = (rows: readonly Row[]) => estimateTokens(rows.filter(hasText).map(row => JSON.stringify(row.message?.content)).join(''))

/** A limit is a token count ("100000") or a percent of the model window ("80%"). */
export function resolveLimit(limit: string, window: number): number {
  const text = limit.trim()
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(text)
  if (percent) return Math.round((Math.min(100, Math.round(Number(percent[1]))) / 100) * window)
  if (/^\d+$/.test(text)) return Number(text)
  throw new Error(`Invalid context limit "${limit}": expected a token count like 100000 or a percent like 80%`)
}

export function blockReport(blocks: ReadonlyMap<number, Block>): string {
  const ids = [...blocks.keys()].sort((a, b) => a - b)
  const head = `Compressed blocks: ${ids.length} (${ids.length > 0 ? ids.map(blockRef).join(', ') : 'none'})`
  if (ids.length === 0) return head
  const sizes = ids.map(id => ({ id, tokens: estimateTokens(blocks.get(id)!.summary) })).sort((a, b) => b.tokens - a.tokens)
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

export function messageReport(rows: readonly Row[], idx: Index): string {
  const sized = [...idx.units]
    .filter(([ref]) => ref.startsWith('m'))
    .map(([ref, unit]) => {
      const span = rows.slice(unit.start, unit.end + 1)
      const chars = span.reduce((sum, row) => sum + (row.message ? JSON.stringify(row.message).length : 0), 0)
      const results = span.reduce((sum, row) => sum + (Array.isArray(row.message?.content) ? row.message.content.filter((b: Row) => b.type === 'tool_result').length : 0), 0)
      return { ref, role: promptText(rows[unit.start]) !== null ? 'user' : 'assistant', tokens: Math.round(chars / 4), results }
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
