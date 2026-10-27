import type { Row } from './rows'

export function parseTranscript(text: string, path: string): Row[] {
  return text
    .split('\n')
    .filter(line => line !== '')
    .map((line, i) => {
      try {
        return JSON.parse(line)
      } catch (err) {
        throw new Error(`${path}:${i + 1}: invalid JSON in transcript: ${String(err)}`)
      }
    })
}

export const serializeTranscript = (rows: readonly Row[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'

const textOf = (row: Row): string =>
  (Array.isArray(row.message?.content) ? row.message.content : [])
    .filter((block: Row) => block.type === 'text')
    .map((block: Row) => block.text)
    .join('')

/** Throws unless the transcript already holds the turn's final answer, since the file is written asynchronously. */
export function assertCurrent(rows: readonly Row[], answer: string, path: string): void {
  const last = rows.findLast(row => row.type === 'assistant' && textOf(row).trim() !== '')
  if (!last || !answer.includes(textOf(last).trim()))
    throw new Error(`${path} does not yet end with the turn's final answer; it lags the session`)
}

/** Throws unless the transcript holds the results of the `ran` tool calls and of every call it holds, since the file is written
    asynchronously: a fork copying a call without its result would be refused by the API, and one missing a call would lose it. */
export function assertAnswered(rows: readonly Row[], ran: readonly string[], path: string): void {
  const blocks = (type: string, role: string) => rows.flatMap(row => (row.type === role && Array.isArray(row.message?.content) ? row.message.content.filter((b: Row) => b.type === type) : []))
  const answered = new Set(blocks('tool_result', 'user').map((b: Row) => b.tool_use_id))
  const open = [...new Set([...ran, ...blocks('tool_use', 'assistant').map((b: Row) => b.id)])].filter(id => !answered.has(id))
  if (open.length > 0) throw new Error(`${path} does not yet hold the results of ${open.join(', ')}; it lags the session`)
}
