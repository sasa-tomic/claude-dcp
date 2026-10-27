export function systemPrompt(tool: string, protectedTools: readonly string[]): string {
  const sections = [
    'You operate in a context-constrained environment: every request re-sends the whole conversation, so stale content costs tokens and attention on every step. Managing the context continuously is part of your job, not cleanup for later.',
    `${tool} is your only context tool. It replaces ranges of the conversation with summaries you write. A call is applied before your next step when that pays, else at the end of the turn: the session is forked and you continue in it with the ranges gone, prompted by a <dcp-system-reminder>.`,
    'Messages and tool results carry <dcp-message-id> tags, and the environment adds <dcp-system-reminder> blocks. Both are injected metadata; never write them yourself. Reminders list the uncompressed history as ranges with their sizes; pick from those.',
    [
      'COMPRESS a range once its raw text has served its purpose:',
      '- research concluded and its findings settled',
      '- implementation finished and verified',
      '- exploration exhausted',
      '- dead ends, failed attempts, superseded file reads and command output: drop these at once, without waiting for the task to close',
    ].join('\n'),
    ['DO NOT COMPRESS:', '- what the next steps need verbatim: files being edited, exact errors, text you will quote', '- work still in progress'].join('\n'),
    'Prefer deleting tool outputs and other big items (file reads, command output, search results, long tool calls). Never compress user prompts or the final answer of a turn: start and end each range at tool-output ids, so the prompt before and the answer after stay in the context.',
    'Before each step ask: is anything above closed enough to become summary-only now? If so, compress it now instead of waiting for a limit. Prefer one call with several ranges, largest first.',
  ]
  if (protectedTools.length > 0)
    sections.push(`The environment keeps the outputs of ${protectedTools.map(t => `\`${t}\``).join(', ')} through compression. Leave them out of summaries.`)
  return sections.join('\n\n')
}

export function toolDescription(tool: string): string {
  return `Replace spans of the conversation with summaries. A range runs from startId to endId inclusive; its messages and tool outputs leave the context.

Summary: it must let you continue with the range gone. Keep paths, signatures, decisions with their reasons, constraints, findings and open items. Drop failed attempts, bulky output and back-and-forth. Quote short user messages; never change the user's scope, constraints or acceptance criteria.

Boundaries: startId and endId are IDs visible in context, mNNNN for a message and bN for an earlier compressed block (shown under a "[Compressed conversation section]" header). startId must not come after endId. Ranges in one call must not overlap; pass independent ranges as separate entries of one ${tool} call. A range inside one an earlier call queued is skipped; a range covering queued ones replaces them.

Blocks inside a range: write (bN) in your summary where block bN's content belongs, and it is replaced by that block's stored summary. Cover every block inside the range exactly once and none outside it. (bN) is only a placeholder; mention a block in prose as "block bN". Place each so the summary still reads correctly once expanded.`
}

const reminder = (lines: string[], guidance: string) => ['<dcp-system-reminder>', ...lines, ...(guidance ? ['', guidance] : []), '</dcp-system-reminder>'].join('\n')

/** Over the max limit: compress now. */
export function limitNudge(tool: string, guidance: string): string {
  return reminder(
    [
      'CRITICAL: the context is over the maximum limit.',
      `You MUST call ${tool} now, before any other tool. Finish an atomic step in progress first.`,
      'Cover as much closed history as is safe in one call, largest and oldest first; the ranges below can be passed as they are. Leave only the newest working messages.',
      'Summaries must carry everything needed to continue; quote short user messages.',
    ],
    guidance,
  )
}

/** Over the min limit, many tool results into a turn: compress what has closed. */
export function iterationNudge(tool: string, guidance: string): string {
  return reminder(
    [
      'The context is over the minimum limit and you have been working for a while since the last user message.',
      `If a range below is closed (finished research, verified work, dead ends, superseded reads and output), call ${tool} on it now. Keep what the next steps need.`,
    ],
    guidance,
  )
}

/** The compress tool's answer: what was queued, what an earlier call already covered, and when it takes effect. */
export function queuedResult(messages: number, notes: readonly string[]): string {
  return [
    `Queued ${messages} message${messages === 1 ? '' : 's'} for compression. They leave the context when it is applied: before your next step when it pays, else at the end of the turn. Do not compress them again.`,
    ...notes,
  ].join('\n')
}

/** The prompt that continues a turn the plugin stopped to apply its compressions. */
export const continuePrompt = (removed: string) =>
  `<dcp-system-reminder>Your compressions were applied (${removed}) and the session continues in a fork. This is not a user message: continue the task where you left off.</dcp-system-reminder>`

/** What /dcp-prune asks, as a user turn: the largest closed chunks, summarised densely, whatever the context size. */
export function prunePrompt(tool: string, hint: string): string {
  return [
    `Compress now: one ${tool} call over everything finished, largest closed chunks first, merging earlier blocks with (bN). Dense summaries: paths, signatures, decisions, errors, open items; no narrative. Leave the newest working messages.`,
    ...(hint ? [`Focus: ${hint}`] : []),
    'Write no text before or after the call.',
  ].join(' ')
}
