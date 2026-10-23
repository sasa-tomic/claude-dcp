import { approxTokens, formatTokens, inputTokens } from './nudges'

/** What the API reported for the requests of one turn, summed. */
export type TurnUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

/** The turns between two forks. `before` is the context of the last request before the fork, `first` that of the first request after it,
    and `removed` their difference. Until that first request is seen (`copied` is set), the fork's own size is only `estimated`. */
export type Segment = {
  removed: number
  before?: number
  estimated?: number
  copied?: number
  turns: number
  first: number
  last: number
  peak: number
  rewritten: number
  uncached: number
  read: number
  written: number
  output: number
}
export type Stats = { segments: Segment[]; gone: string[]; refetches: number }

// Only a proxy for lost information, so the oldest signatures go first once there are this many.
const GONE_LIMIT = 2000

const segment = (removed: number, before?: number): Segment => ({ removed, before, turns: 0, first: 0, last: 0, peak: 0, rewritten: 0, uncached: 0, read: 0, written: 0, output: 0 })

export const emptyStats = (): Stats => ({ segments: [segment(0)], gone: [], refetches: 0 })

export const savedTokens = (stats: Stats) => stats.segments.reduce((sum, s) => sum + s.removed, 0)

/** Adds a finished turn: `context` is the input side of its last request, `usage` the sum over its requests. */
export function recordTurn(stats: Stats, context: number, usage: TurnUsage): Stats {
  const last = stats.segments.at(-1)!
  const next: Segment = {
    ...last,
    turns: last.turns + 1,
    first: last.first > 0 ? last.first : context,
    last: context,
    peak: Math.max(last.peak, context),
    uncached: last.uncached + usage.input_tokens,
    read: last.read + usage.cache_read_input_tokens,
    written: last.written + usage.cache_creation_input_tokens,
    output: last.output + usage.output_tokens,
  }

  return { ...stats, segments: [...stats.segments.slice(0, -1), next] }
}

/** Opens the segment after a fork, remembering the calls whose output the fork compressed away. `copied` is the number of rows
    of the forked transcript, so the first request after them is the fork's first. */
export function recordFork(stats: Stats, fork: { before: number; estimated: number; copied: number; gone: readonly string[] }): Stats {
  const opened = { ...segment(0, fork.before), estimated: fork.estimated, copied: fork.copied }

  return { ...stats, segments: [...stats.segments, opened], gone: [...stats.gone, ...fork.gone].slice(-GONE_LIMIT) }
}

/** Whether the last fork still waits for the first request after it, until when the engine's context figures are the old session's. */
export const isAwaitingFirst = (stats: Stats) => stats.segments.at(-1)!.copied !== undefined

/** Settles the fork the last segment opened: what the API counted for the first request after it. */
export function recordFirstRequest(stats: Stats, request: TurnUsage): Stats {
  const last = stats.segments.at(-1)!
  const { estimated: _estimated, copied: _copied, ...rest } = last
  if (last.copied === undefined || last.before === undefined) throw new Error('no fork is waiting for its first request')
  const first = inputTokens(request)

  return { ...stats, segments: [...stats.segments.slice(0, -1), { ...rest, first, removed: last.before - first, rewritten: request.cache_creation_input_tokens }] }
}

/** Counts a call that repeats one compressed away earlier. */
export const recordCall = (stats: Stats, hash: string): Stats => (stats.gone.includes(hash) ? { ...stats, refetches: stats.refetches + 1 } : stats)

/** A short stable key of a call signature (FNV-1a), small enough to keep thousands in the store. */
export function hashSignature(signature: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < signature.length; i++) h = Math.imul(h ^ signature.charCodeAt(i), 0x01000193)

  return (h >>> 0).toString(36)
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function renderStats(stats: Stats): string {
  const forks = stats.segments.length - 1
  const turns = stats.segments.reduce((sum, s) => sum + s.turns, 0)
  const total = (field: 'uncached' | 'read' | 'written' | 'output') => stats.segments.reduce((sum, s) => sum + s[field], 0)
  const waiting = stats.segments.filter(s => s.copied !== undefined).length
  const lines = [
    `${plural(forks, 'fork')} over ${plural(turns, 'turn')}; ${formatTokens(savedTokens(stats))} tokens removed (measured: the context before each fork minus the first request after it, which also holds your next prompt)${waiting > 0 ? `; ${waiting} not measured yet` : ''}.`,
    `${plural(stats.refetches, 'call')} repeated one compressed away (a proxy for lost information; a changed file counts too).`,
    '',
    'Context per segment, first → last turn (peak), then what the fork that opened it did:',
    ...stats.segments.map((s, i) => {
      if (i === 0) return s.turns === 0 ? '1. no turn yet' : `1. ${plural(s.turns, 'turn')} · ${formatTokens(s.first)} → ${formatTokens(s.last)} (peak ${formatTokens(s.peak)})`
      const fork = s.copied === undefined ? `fork removed ${formatTokens(s.removed)} of ${formatTokens(s.before!)}, its first request wrote ${formatTokens(s.rewritten)} to the cache` : `fork estimated at ${approxTokens(s.estimated!)}, not measured until its first request`

      return s.turns === 0 && s.copied !== undefined ? `${i + 1}. ${fork}` : `${i + 1}. ${plural(s.turns, 'turn')} · ${formatTokens(s.first)} → ${formatTokens(s.last)} (peak ${formatTokens(s.peak)}) · ${fork}`
    }),
    '',
    `Billed tokens: ${formatTokens(total('uncached'))} uncached · ${formatTokens(total('written'))} cache writes · ${formatTokens(total('read'))} cache reads · ${formatTokens(total('output'))} output.`,
  ]
  return lines.join('\n')
}
