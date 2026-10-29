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
// state Claude Code supplies and stay, less the copies staleCopies finds superseded.
const isRemovable = (row: Row) =>
  row.type === 'user' || row.type === 'assistant' || isQueuedCommand(row) || tagOf(row) !== null || (row.type === 'attachment' && row.attachment?.type === 'total_tokens_reminder')

// The key under which a later attachment supersedes an earlier one: a memory file (CLAUDE.md) by its path, as Claude Code attaches the whole file
// again on resume and on entering its directory and only the newest copy is current; any other attachment by the body the model is sent, as an
// identical later copy repeats it. Queued commands and this plugin's id tags are conversation, not state, and never qualify.
const supersedeKey = (row: Row): string | null => {
  if (row.type !== 'attachment' || isQueuedCommand(row) || tagOf(row) !== null) return null
  if (row.attachment?.type === 'nested_memory') return `memory:${row.attachment.path}`
  return row.rendered ? JSON.stringify(row.rendered) : null
}

/** Attachments a later one supersedes: older copies of a memory file and repeats of an identical attachment; the newest stays. */
export function staleCopies(rows: readonly Row[]): number[] {
  const newest = new Map<string, number>()
  rows.forEach((row, i) => {
    const key = supersedeKey(row)
    if (key !== null) newest.set(key, i)
  })
  return rows.flatMap((row, i) => {
    const key = supersedeKey(row)
    return key !== null && newest.get(key) !== i ? [i] : []
  })
}

const CRON_CARRY = 'session_cron_carry'
const isCronCarry = (row: Row) => row.type === 'attachment' && row.attachment?.type === CRON_CARRY

/** Claude Code re-arms a session's crons on resume from its CronCreate calls less its CronDelete ones, and from the last
    session_cron_carry note. The note the fork writes when it removes such calls: the previous note's tasks plus the crons the removed
    calls made, less the ended ones; null when it removes none. */
export function cronCarry(rows: readonly Row[], idx: Index, removed: ReadonlySet<number>): Row | null {
  const gone = idx.calls.filter(c => removed.has(c.useRow) && !c.isError && (c.name === 'CronCreate' || c.name === 'CronDelete'))
  if (gone.length === 0) return null
  const notes = rows.filter(isCronCarry).map(r => r.attachment)
  const ended = new Set<string>([...notes.flatMap(n => n.ended ?? []), ...idx.calls.filter(c => c.name === 'CronDelete' && !c.isError).map(c => c.input.id)])
  const made = gone.flatMap(c => {
    const result = rows[c.resultRow!].toolUseResult
    if (c.name !== 'CronCreate' || result.durable === true) return []
    const createdAt = Date.parse(rows[c.useRow].timestamp)
    if (typeof result.id !== 'string' || Number.isNaN(createdAt)) throw new Error(`CronCreate ${c.id} at row ${c.useRow} has no job id or timestamp to carry: ${JSON.stringify(result)}`)
    return [{ id: result.id, cron: c.input.cron, prompt: c.input.prompt, createdAt, recurring: result.recurring === true }]
  })
  const tasks = [...(notes.at(-1)?.tasks ?? []), ...made].filter(t => !ended.has(t.id))

  return { ...notes.at(-1), type: CRON_CARRY, tasks, ended: [...ended] }
}

export type ApplyContext = { sessionId: string; newUuid: () => string }

/** Replaces each planned range with one summary user row and drops superseded attachments, relinking the parentUuid chain; rows are never mutated.
    When it removes cron calls, one cron carry note replaces the earlier ones. */
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
  const carry = cronCarry(rows, idx, removed)
  const superseded = [...staleCopies(rows), ...(carry ? rows.flatMap((r, i) => (isCronCarry(r) ? [i] : [])) : [])]
  for (const i of superseded) {
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
  if (!carry) return out
  // right after the last summary: Claude Code may resume a fork short of its last rows, but the summaries are always on the chain it loads
  const lastSummary = summaryAt.get(Math.max(...summaryAt.keys()))!.uuid
  const at = out.findIndex(r => r.uuid === lastSummary)
  const summary = out[at]
  const note: Row = { parentUuid: summary.uuid, ...Object.fromEntries(SUMMARY_ROW_FIELDS.filter(f => f in summary).map(f => [f, summary[f]])), type: 'attachment', uuid: ctx.newUuid(), sessionId: ctx.sessionId, attachment: carry }
  return [...out.slice(0, at + 1), note, ...out.slice(at + 1).map(r => (r.parentUuid === summary.uuid ? { ...r, parentUuid: note.uuid } : r))]
}
