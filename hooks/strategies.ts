import { type Index, type ToolCall } from './model'
import { isProtected } from './protected'
import type { Row } from './rows'

export const PRUNED_TOOL_OUTPUT = '[output pruned: duplicate or stale]'
export const PRUNED_TOOL_ERROR_INPUT = '[input pruned: the call failed]'
export const PRUNED_QUESTION_INPUT = "[questions pruned: the answers are in the output]"

const QUESTION_TOOL = 'AskUserQuestion'
const KEPT_OUTPUT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

export type StrategyConfig = { deduplication: boolean; purgeErrors: boolean; purgeErrorsTurns: number; protectedFilePatterns: readonly string[] }

const sortKeys = (value: any): any =>
  Array.isArray(value) ? value.map(sortKeys) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sortKeys(value[k])])) : value

/** Identifies a call by tool and arguments, ignoring unset ones and key order. */
export const callSignature = (name: string, input: Record<string, any>) => {
  const present = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== null))
  return `${name}::${JSON.stringify(sortKeys(present))}`
}

/** The tool call ids whose output (or, for failed calls, input) is pruned: duplicates and old errors. */
export function markPruned(idx: Index, config: StrategyConfig): Set<string> {
  const pruned = new Set<string>()
  const unprotected = idx.calls.filter(c => !isProtected(c.name, c.input, [], config.protectedFilePatterns))

  if (config.deduplication) {
    const bySignature = new Map<string, string[]>()
    for (const call of unprotected) bySignature.set(callSignature(call.name, call.input), [...(bySignature.get(callSignature(call.name, call.input)) ?? []), call.id])
    for (const ids of bySignature.values()) for (const id of ids.slice(0, -1)) pruned.add(id)
  }
  if (config.purgeErrors) {
    const threshold = Math.max(1, config.purgeErrorsTurns)
    for (const call of unprotected) if (call.isError && idx.currentTurn - call.turn >= threshold) pruned.add(call.id)
  }
  return pruned
}

export function applyPrunes(rows: readonly Row[], idx: Index, pruned: ReadonlySet<string>): Row[] {
  const byRow = new Map<number, ToolCall[]>()
  for (const call of idx.calls) {
    if (!pruned.has(call.id)) continue
    for (const row of [call.useRow, call.resultRow]) if (row !== undefined) byRow.set(row, [...(byRow.get(row) ?? []), call])
  }
  return rows.map((row, i) => {
    const calls = byRow.get(i)
    if (!calls) return row
    const copy: Row = structuredClone(row)
    for (const block of copy.message.content) {
      const call = calls.find(c => c.id === (block.type === 'tool_use' ? block.id : block.tool_use_id))
      if (!call) continue
      if (block.type === 'tool_use' && call.isError) {
        for (const key of Object.keys(block.input)) if (typeof block.input[key] === 'string') block.input[key] = PRUNED_TOOL_ERROR_INPUT
      } else if (block.type === 'tool_use' && call.name === QUESTION_TOOL && block.input.questions !== undefined) {
        block.input.questions = PRUNED_QUESTION_INPUT
      } else if (block.type === 'tool_result' && !call.isError && call.name !== QUESTION_TOOL && !KEPT_OUTPUT_TOOLS.includes(call.name)) {
        block.content = PRUNED_TOOL_OUTPUT
      }
    }
    return copy
  })
}
