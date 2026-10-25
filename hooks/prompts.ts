export function systemPrompt(tool: string, protectedTools: readonly string[]): string {
  const sections = [
    `Your context window is finite. ${tool} is your only context tool: it swaps a span of the conversation for a summary you write.`,
    'Messages and tool results carry <dcp-message-id> tags, and the environment adds <dcp-system-reminder> blocks. Both are injected metadata; never write them yourself.',
    'Compress a span once it is finished: research with settled findings, work that is implemented and verified, exploration that ended, dead ends. Leave what the next steps need verbatim: files being edited, exact errors, text you will quote, work in progress.',
    'Prefer deleting tool outputs and other big items (file reads, command output, search results, long tool calls). Never compress user prompts or the final answer of a turn: start and end each range at tool-output ids, so the prompt before and the answer after stay in the context.',
    'For each span ask: can I continue with only its summary? If so, compress it now instead of waiting for a limit.',
  ]
  if (protectedTools.length > 0)
    sections.push(`The environment keeps the outputs of ${protectedTools.map(t => `\`${t}\``).join(', ')} through compression. Leave them out of summaries.`)
  return sections.join('\n\n')
}

export function toolDescription(tool: string): string {
  return `Replace spans of the conversation with summaries. A range runs from startId to endId inclusive; its messages and tool outputs leave the context.

Summary: it must let you continue with the range gone. Keep paths, signatures, decisions with their reasons, constraints, findings and open items. Drop failed attempts, bulky output and back-and-forth. Quote short user messages; never change the user's scope, constraints or acceptance criteria.

Boundaries: startId and endId are IDs visible in context, mNNNN for a message and bN for an earlier compressed block (shown under a "[Compressed conversation section]" header). startId must not come after endId. Ranges in one call must not overlap; pass independent ranges as separate entries of one ${tool} call.

Blocks inside a range: write (bN) in your summary where block bN's content belongs, and it is replaced by that block's stored summary. Cover every block inside the range exactly once and none outside it. (bN) is only a placeholder; mention a block in prose as "block bN". Place each so the summary still reads correctly once expanded.`
}

export function limitNudge(tool: string, guidance: string): string {
  return [
    '<dcp-system-reminder>',
    'Context is at or over the maximum limit.',
    `Call ${tool} now. Finish an atomic step in progress first, then compress before anything else.`,
    'Start from the oldest finished history and cover as much of it as is safe in one call. Leave the newest working messages unless they are finished.',
    'Summaries must carry everything needed to continue; quote short user messages.',
    ...(guidance ? ['', guidance] : []),
    '</dcp-system-reminder>',
  ].join('\n')
}

/** What /dcp-prune asks, as a user turn: the largest closed chunks, summarised densely, whatever the context size. */
export function prunePrompt(tool: string, hint: string): string {
  return [
    `Compress now: one ${tool} call over everything finished, largest closed chunks first, merging earlier blocks with (bN). Dense summaries: paths, signatures, decisions, errors, open items; no narrative. Leave the newest working messages.`,
    ...(hint ? [`Focus: ${hint}`] : []),
    'Write no text before or after the call.',
  ].join(' ')
}
