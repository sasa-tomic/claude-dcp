import { AFTER_CALL } from './prompts'

export const STUB_MAX_CHARS = 200
/** What the stub rule enforces: the asked length with room for a model's miscount, so a stub a few characters over is not a wasted call. */
export const STUB_LIMIT_CHARS = 300

export type StopTier = 'drop' | 'compress' | 'aggressive'

/** Below min only dead weight is dropped; from min, the largest chunks are paraphrased; above max everything not needed next goes. */
export const stopTier = (tokens: number, min: number, max: number): StopTier => (tokens < min ? 'drop' : tokens <= max ? 'compress' : 'aggressive')

export const stopPrompt = (tier: StopTier, toolName: string): string =>
  ({
    drop: `End of turn. DROP what you no longer need: one ${toolName} call, a range per dead stretch (finished work, superseded reads, failed attempts). Summary = stub, max ${STUB_MAX_CHARS} chars, no content. Nothing dead: no call. ${AFTER_CALL}`,
    compress: `End of turn, context over min. DROP dead stretches (stub summaries), then compress and merge the largest closed chunks below into dense summaries (paths, signatures, decisions, errors, open items; no narrative); merge blocks into denser summaries. One ${toolName} call. ${AFTER_CALL}`,
    aggressive: `End of turn, context over max: VERY AGGRESSIVE. One ${toolName} call: compress everything the next step does not need, largest first; merge all blocks. Prefer keeping key information, especially from the 2-3 most recent turns. Keep task state, decisions, paths, open items, minimal words. ${AFTER_CALL}`,
  })[tier]

const FOLDED_SUMMARY_CHARS = 80

/** The compress call as its transcript row shows it: each summary cut to its head with its size, the stored call untouched; other shapes pass through. */
export function foldCompressInput(input: unknown): unknown {
  const content = (input as { content?: unknown } | null)?.content
  if (!Array.isArray(content) || !content.every(c => typeof c?.summary === 'string')) return input
  const folded = content.map(c => ({ ...c, summary: c.summary.length > FOLDED_SUMMARY_CHARS ? `${c.summary.slice(0, FOLDED_SUMMARY_CHARS)}… (${c.summary.length} chars)` : c.summary }))

  return { ...(input as object), content: folded }
}
