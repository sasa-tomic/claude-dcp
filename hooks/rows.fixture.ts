import { tagLine } from './ids'
import type { Row } from './rows'

export const BLOCK_HEADER = '[Compressed conversation section]'

/** Builds Claude Code transcript rows with a parentUuid chain, as the engine writes them. */
export class Transcript {
  rows: Row[] = []
  private last: string | null = null
  private n = 0
  // what the API would have counted: a quarter of a row's characters, the input of a request being all the rows before it
  private tokens = 0

  private push(row: Row): number {
    const uuid = `u${++this.n}`
    const own = row.message ? Math.round(JSON.stringify(row.message.content).length / 4) : 0
    if (row.type === 'assistant') row.message.usage = { input_tokens: this.tokens, output_tokens: own, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    this.tokens += own
    this.rows.push({ parentUuid: this.last, isSidechain: false, uuid, sessionId: 's1', ...row })
    this.last = uuid
    return this.rows.length - 1
  }

  /** A prompt row, from `origin` (the user's: 'human') and, with `ref`, the hidden-context attachment row that carries its id. */
  prompt(text: string, ref?: string, origin?: string): number {
    const row = this.push({ type: 'user', message: { role: 'user', content: text }, ...(origin ? { origin: { kind: origin } } : {}) })
    if (ref)
      this.push({
        type: 'attachment',
        attachment: { type: 'hook_additional_context', content: [tagLine(ref).trim()], hookName: 'prompt.submit', hookEvent: 'UserPromptSubmit' },
      })
    return row
  }

  /** A message that arrived while a turn ran, which the turn took in. */
  queued(prompt: string, origin: string): number {
    return this.push({ type: 'attachment', attachment: { type: 'queued_command', prompt, origin: { kind: origin }, commandMode: 'prompt' } })
  }

  block(blockId: number, body: string): number {
    return this.push({ type: 'user', message: { role: 'user', content: `${BLOCK_HEADER}\n${body}${tagLine(`b${blockId}`)}` } })
  }

  text(text: string, msg = `msg${this.n + 1}`): number {
    return this.push({ type: 'assistant', message: { id: msg, role: 'assistant', content: [{ type: 'text', text }] } })
  }

  /** One assistant tool call, its result row, and (with `ref`) the tag attachment the hook adds. */
  call(name: string, input: Record<string, unknown>, opts: { ref?: string; output?: string; isError?: boolean; id?: string; msg?: string } = {}): number {
    const id = opts.id ?? `toolu_${this.n + 1}`
    const msg = opts.msg ?? `msg${this.n + 1}`
    this.push({ type: 'assistant', message: { id: msg, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
    const result = this.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: opts.output ?? 'ok', ...(opts.isError ? { is_error: true } : {}) }] },
      toolUseResult: { echo: opts.output ?? 'ok' },
    })
    if (!opts.ref) return result
    return this.push({
      type: 'attachment',
      attachment: { type: 'hook_additional_context', content: [tagLine(opts.ref).trim()], hookName: 'tool.call', toolUseID: `${id}-context`, hookEvent: 'PostToolUse' },
    })
  }
}
