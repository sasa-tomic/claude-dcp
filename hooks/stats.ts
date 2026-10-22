import { formatTokens } from './nudges'

/** What the API reported for the requests of one turn, summed. */
export type TurnUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

/** The turns between two forks. The first turn after a fork pays to write the cache again, so it is kept apart. */
export type Segment = {
  removed: number
  before?: number
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
  const first = last.turns === 0
  const next: Segment = {
    ...last,
    turns: last.turns + 1,
    first: first ? context : last.first,
    last: context,
    peak: Math.max(last.peak, context),
    rewritten: first ? usage.cache_creation_input_tokens : last.rewritten,
    uncached: last.uncached + usage.input_tokens,
    read: last.read + usage.cache_read_input_tokens,
    written: last.written + usage.cache_creation_input_tokens,
    output: last.output + usage.output_tokens,
  }

  return { ...stats, segments: [...stats.segments.slice(0, -1), next] }
}

/** Opens the segment after a fork, remembering the calls whose output the fork compressed away. */
export function recordFork(stats: Stats, fork: { removed: number; before?: number; gone: readonly string[] }): Stats {
  return { ...stats, segments: [...stats.segments, segment(fork.removed, fork.before)], gone: [...stats.gone, ...fork.gone].slice(-GONE_LIMIT) }
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
  const lines = [
    `${plural(forks, 'fork')} over ${plural(turns, 'turn')}; about ${formatTokens(savedTokens(stats))} tokens removed (estimate: characters / 4).`,
    `${plural(stats.refetches, 'call')} repeated one compressed away (a proxy for lost information; a changed file counts too).`,
    '',
    'Context per segment, first → last turn (peak), then what the fork that opened it did:',
    ...stats.segments.map((s, i) => {
      if (s.turns === 0) return `${i + 1}. no turn yet`
      const fork = i === 0 ? '' : ` · fork removed ~${formatTokens(s.removed)} of ${s.before === undefined ? '?' : formatTokens(s.before)}, first turn wrote ${formatTokens(s.rewritten)} to the cache`

      return `${i + 1}. ${plural(s.turns, 'turn')} · ${formatTokens(s.first)} → ${formatTokens(s.last)} (peak ${formatTokens(s.peak)})${fork}`
    }),
    '',
    `Billed tokens: ${formatTokens(total('uncached'))} uncached · ${formatTokens(total('written'))} cache writes · ${formatTokens(total('read'))} cache reads · ${formatTokens(total('output'))} output.`,
  ]
  return lines.join('\n')
}
