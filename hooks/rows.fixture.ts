import { tagLine } from './ids'
import type { Row } from './rows'

export const BLOCK_HEADER = '[Compressed conversation section]'

/** Builds Claude Code transcript rows with a parentUuid chain, as the engine writes them. */
export class Transcript {
  rows: Row[] = []
  private last: string | null = null
  private n = 0

  private push(row: Row): number {
    const uuid = `u${++this.n}`
    this.rows.push({ parentUuid: this.last, isSidechain: false, uuid, sessionId: 's1', ...row })
    this.last = uuid
    return this.rows.length - 1
  }

  /** A prompt row and, with `ref`, the hidden-context attachment row that carries its id. */
  prompt(text: string, ref?: string): number {
    const row = this.push({ type: 'user', message: { role: 'user', content: text } })
    if (ref)
      this.push({
        type: 'attachment',
        attachment: { type: 'hook_additional_context', content: [tagLine(ref).trim()], hookName: 'prompt.submit', hookEvent: 'UserPromptSubmit' },
      })
    return row
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
