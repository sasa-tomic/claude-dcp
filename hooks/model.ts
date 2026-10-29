import { loneRef, trailingRef } from './ids'
import type { Row } from './rows'

export const COMPRESSED_BLOCK_HEADER = '[Compressed conversation section]'
export const COMPRESS_TOOL = 'mcp__dcp__compress'
const CONTEXT_SUFFIX = '-context'

/** Rows `start..end` that one id covers; a tool result's id also names its call. */
export type Unit = { start: number; end: number; call?: ToolCall }
export type ToolCall = {
  id: string
  name: string
  input: Record<string, any>
  useRow: number
  resultRow?: number
  isError: boolean
  resultText: string
  turn: number
}
export type Block = { row: number; summary: string }
export type Index = {
  units: Map<string, Unit>
  blocks: Map<number, Block>
  calls: ToolCall[]
  currentTurn: number
  maxMessageRef: number
  maxBlockId: number
}

export const promptText = (row: Row): string | null => {
  if (row.type !== 'user') return null
  const content = row.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || content.length === 0 || !content.every((b: Row) => b.type === 'text')) return null
  return content.map((b: Row) => b.text).join('')
}

export const isQueuedCommand = (row: Row) => row.type === 'attachment' && row.attachment?.type === 'queued_command'

/** The id carried by a hook_additional_context attachment that this plugin added to a prompt or a tool result, else null. */
export function tagOf(row: Row): string | null {
  const a = row.attachment
  if (row.type !== 'attachment' || a?.type !== 'hook_additional_context' || !['prompt.submit', 'tool.call'].includes(a.hookName) || !Array.isArray(a.content)) return null
  return a.content.map((entry: string) => loneRef(entry)).find(Boolean) ?? null
}

export const blockText = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((b: Row) => b.text ?? '').join('') : JSON.stringify(content)

function messageStart(rows: readonly Row[], useRow: number): number {
  const id = rows[useRow].message.id
  let start = useRow
  while (start > 0 && rows[start - 1].type === 'assistant' && rows[start - 1].message?.id === id) start--
  return start
}

export function indexRows(rows: readonly Row[]): Index {
  const calls: ToolCall[] = []
  const callById = new Map<string, ToolCall>()
  const seenAssistant = new Set<string>()
  rows.forEach((row, i) => {
    const content = row.message?.content
    if (row.type === 'assistant' && Array.isArray(content)) {
      seenAssistant.add(row.message.id)
      for (const b of content)
        if (b.type === 'tool_use') {
          const call: ToolCall = { id: b.id, name: b.name, input: b.input ?? {}, useRow: i, isError: false, resultText: '', turn: seenAssistant.size }
          calls.push(call)
          callById.set(b.id, call)
        }
    }
    if (row.type === 'user' && Array.isArray(content))
      for (const b of content)
        if (b.type === 'tool_result' && callById.has(b.tool_use_id)) {
          const call = callById.get(b.tool_use_id)!
          call.resultRow = i
          call.isError = b.is_error === true
          call.resultText = blockText(b.content)
        }
  })

  const units = new Map<string, Unit>()
  const blocks = new Map<number, Block>()
  const claim = (ref: string, unit: Unit) => {
    const prior = units.get(ref)
    if (prior) throw new Error(`message id ${ref} appears at rows ${prior.end} and ${unit.end}`)
    units.set(ref, unit)
  }
  // the prompt a prompt.submit tag closes: a typed prompt row, or a queued command (a task notification) the turn took in
  let open = -1
  rows.forEach((row, i) => {
    const text = promptText(row)
    if (text !== null) {
      const blockRef = text.startsWith(COMPRESSED_BLOCK_HEADER) ? trailingRef(text) : null
      if (blockRef) {
        claim(blockRef, { start: i, end: i })
        blocks.set(Number(blockRef.slice(1)), { row: i, summary: text })
      } else open = i
      return
    }
    if (isQueuedCommand(row)) open = i
    const tag = tagOf(row)
    if (!tag?.startsWith('m')) return
    if (row.attachment.hookName === 'prompt.submit') {
      if (open < 0) throw new Error(`message id ${tag} at row ${i} has no prompt before it`)
      claim(tag, { start: open, end: i })
      open = -1
      return
    }
    const call = callById.get(String(row.attachment.toolUseID).replace(new RegExp(`${CONTEXT_SUFFIX}$`), ''))
    if (!call) throw new Error(`message id ${tag} at row ${i} names no tool call`)
    claim(tag, { start: messageStart(rows, call.useRow), end: i, call })
  })

  const refNumbers = [...units.keys()].filter(r => r.startsWith('m')).map(r => Number(r.slice(1)))
  return {
    units,
    blocks,
    calls,
    currentTurn: seenAssistant.size,
    maxMessageRef: Math.max(0, ...refNumbers),
    maxBlockId: Math.max(0, ...blocks.keys()),
  }
}
