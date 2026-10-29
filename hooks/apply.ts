import type { Plan } from './compress'
import { tagLine } from './ids'
import { COMPRESSED_BLOCK_HEADER, type Index, isQueuedCommand, tagOf } from './model'
import type { Row } from './rows'

const SUMMARY_ROW_FIELDS = ['isSidechain', 'userType', 'entrypoint', 'cwd', 'version', 'gitBranch', 'timestamp'] as const

export function wrapCompressedSummary(blockId: number, summary: string): string {
  const footer = tagLine(`b${blockId}`)
  const body = summary.trim()
  return body.length === 0 ? `${COMPRESSED_BLOCK_HEADER}\n${footer}` : `${COMPRESSED_BLOCK_HEADER}\n${body}\n\n${footer}`
}

// Rows that go with the conversation: messages, task notifications a turn took in, this plugin's id tags, and the token-count reminders,
// which are stale as soon as the next one arrives. Other attachments (skill and tool listings, instructions, environment, memory) are
// state Claude Code supplies and stay.
const isRemovable = (row: Row) =>
  row.type === 'user' || row.type === 'assistant' || isQueuedCommand(row) || tagOf(row) !== null || (row.type === 'attachment' && row.attachment?.type === 'total_tokens_reminder')

const isMemory = (row: Row) => row.type === 'attachment' && row.attachment?.type === 'nested_memory'

/** Copies of a memory file (CLAUDE.md) that a later copy of the same path supersedes: Claude Code attaches the whole file again on resume and on
 * entering its directory, and only the newest copy is current. */
export function staleCopies(rows: readonly Row[]): number[] {
  const newest = new Map<string, number>()
  rows.forEach((row, i) => isMemory(row) && newest.set(row.attachment.path, i))
  return rows.flatMap((row, i) => (isMemory(row) && newest.get(row.attachment.path) !== i ? [i] : []))
}

export type ApplyContext = { sessionId: string; newUuid: () => string }

/** Replaces each planned range with one summary user row and drops stale memory copies, relinking the parentUuid chain; rows are never mutated. */
export function applyCompression(rows: readonly Row[], idx: Index, plans: readonly Plan[], ctx: ApplyContext): Row[] {
  const ordered = [...plans].sort((a, b) => a.s - b.s)
  const redirect = new Map<string, string | null>()
  const summaryAt = new Map<number, Row>()
  const removed = new Set<number>()

  ordered.forEach((plan, k) => {
    const first = rows.slice(plan.s, plan.e + 1).findIndex(isRemovable) + plan.s
    const template = rows[first]
    const summary: Row = { parentUuid: template.parentUuid, type: 'user', uuid: ctx.newUuid(), sessionId: ctx.sessionId }
    for (const field of SUMMARY_ROW_FIELDS) if (field in template) summary[field] = template[field]
    summary.message = { role: 'user', content: wrapCompressedSummary(idx.maxBlockId + 1 + k, plan.finalSummary) }
    summaryAt.set(first, summary)
    for (let i = plan.s; i <= plan.e; i++)
      if (isRemovable(rows[i])) {
        removed.add(i)
        redirect.set(rows[i].uuid, summary.uuid)
      }
  })
  for (const i of staleCopies(rows)) {
    removed.add(i)
    redirect.set(rows[i].uuid, rows[i].parentUuid ?? null)
  }

  const resolve = (uuid: string | null): string | null => {
    let current = uuid
    while (current !== null && redirect.has(current)) current = redirect.get(current)!
    return current
  }
  const out: Row[] = []
  rows.forEach((row, i) => {
    const summary = summaryAt.get(i)
    if (summary) out.push({ ...summary, parentUuid: resolve(summary.parentUuid) })
    if (removed.has(i)) return
    const copy: Row = { ...row, parentUuid: resolve(row.parentUuid ?? null) }
    for (const key of ['sessionId', 'session_id']) if (key in copy) copy[key] = ctx.sessionId
    out.push(copy)
  })
  return out
}
