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
