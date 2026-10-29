import { describe, expect, test } from 'claude-code/testing'

import { indexRows } from './model'
import { answeredRequests, approxTokens, blockReport, callLabel, formatTokens, historyReport, resolveLimit, rowChars, tokensOf, tokensPerChar } from './nudges'
import { Transcript } from './rows.fixture'

describe('resolveLimit', () => {
  test('reads token counts and percentages of the model window', () => {
    expect(resolveLimit('100000', 200000)).toBe(100000)
    expect(resolveLimit('40%', 200000)).toBe(80000)
    expect(resolveLimit(' 150% ', 1000)).toBe(1000)
  })

  test('rejects anything else loudly', () => {
    expect(() => resolveLimit('lots', 200000)).toThrow('Invalid context limit "lots"')
    expect(() => resolveLimit('-5', 200000)).toThrow('Invalid context limit')
  })
})

describe('token estimates', () => {
  test('turns characters into tokens at the rate measured for the conversation, and formats thousands with one decimal', () => {
    expect(tokensOf(400, 0.25)).toBe(100)
    expect(tokensOf(400, 0.33)).toBe(132)
    expect(approxTokens(950)).toBe('~950')
    expect(approxTokens(12345)).toBe('~12.3k')
  })
})

describe('tokensPerChar', () => {
  const answer = (id: string, input: number, output: number, text = 'a', model = 'm') => ({ type: 'assistant', message: { id, model, content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: output, cache_read_input_tokens: input - 2, cache_creation_input_tokens: 1 } } })
  const result = (chars: number) => ({ type: 'user', message: { role: 'user', content: 'y'.repeat(chars) } })

  test('divides what the API counted the input to grow between consecutive requests by the characters of the rows added, answer included', () => {
    const rows = [answer('a', 1000, 50), result(998), answer('b', 1450, 30), result(398), answer('c', 1750, 10)]
    // the input grew 450 over the first answer and its result, 300 over the second
    const chars = rowChars(rows.slice(0, 4))
    expect(tokensPerChar(rows)).toBe(750 / chars)
    expect(tokensPerChar(rows)).toBeGreaterThan(0.45)
    expect(tokensPerChar(rows)).toBeLessThan(0.55)
  })

  test('counts the rows of one request once, whatever the number of rows the answer spans', () => {
    const rows = [answer('a', 1000, 50), answer('a', 1000, 50, 'b'), result(998), answer('b', 1500, 30)]
    expect(tokensPerChar(rows)).toBe(500 / rowChars(rows.slice(0, 3)))
  })

  test('leaves out a pair that does not grow past its answer (the first request after a fork starts over), a pair across a compressed block, and Claude Code placeholder answers', () => {
    const t = new Transcript()
    t.block(1, 'summary')
    const restart = [answer('a', 5000, 50), result(998), answer('b', 700, 30), result(398), answer('c', 1000, 10)]
    expect(tokensPerChar(restart)).toBe(300 / rowChars(restart.slice(2, 4)))
    expect(tokensPerChar([answer('a', 1000, 50), result(998), answer('b', 1450, 30), ...t.rows, answer('c', 1700, 10)])).toBe(450 / rowChars([answer('a', 1000, 50), result(998)]))
    const placeholder = [answer('a', 1000, 50), result(998), answer('s', 0, 0, 'No response requested.', '<synthetic>'), answer('b', 1450, 30)]
    expect(tokensPerChar(placeholder)).toBe(450 / rowChars(placeholder.slice(0, 3)))
  })

  test('lists the answered requests once each, in file order, without placeholders and rows that carry no usage', () => {
    const rows = [{ type: 'user', message: { content: 'hi' } }, answer('a', 1000, 50), answer('a', 1000, 60, 'b'), answer('s', 0, 0, 'x', '<synthetic>'), { type: 'assistant', message: { id: 'bare', content: [] } }, answer('b', 1100, 5)]
    expect(answeredRequests(rows).map(r => [r.first, r.usage.output_tokens])).toEqual([[1, 60], [5, 5]])
  })

  test('is undefined when there is nothing to measure', () => {
    expect(tokensPerChar([])).toBeUndefined()
    expect(tokensPerChar([answer('a', 1000, 50)])).toBeUndefined()
  })
})

describe('conversation size', () => {
  test('formats exact token counts without a tilde', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(62300)).toBe('62.3k')
  })

  test('weighs only the message content of user and assistant rows', () => {
    const t = new Transcript()
    t.prompt('x'.repeat(400))
    t.call('Read', {}, { output: 'y'.repeat(800) })
    t.rows.push({ type: 'queue-operation', content: 'z'.repeat(8000) })
    expect(rowChars(t.rows)).toBeGreaterThan(1300)
    expect(rowChars(t.rows)).toBeLessThan(1400)
  })
})

describe('reports', () => {
  test('block report with no blocks is one line', () => {
    expect(blockReport(new Map(), 0.25)).toBe('Compressed blocks: 0 (none)')
  })

  test('block report lists the largest blocks, their total and the order of preference', () => {
    const blocks = new Map(Array.from({ length: 10 }, (_, i) => [i + 1, { row: i, summary: 'x'.repeat((i + 1) * 4000) }] as const))
    const text = blockReport(blocks, 0.25)
    expect(text).toContain('Compressed blocks: 10 (b1, b2, b3, b4, b5, b6, b7, b8, b9, b10)')
    expect(text).toContain('  - b10: ~10.0k\n  - b9: ~9.0k')
    expect(text).toContain('  - ... +2 smaller')
    expect(text).toContain('~55.0k in total')
    expect(text).toContain('1. Drop ranges you no longer need.')
    expect(text).toContain('(e.g. b1..b8)')
    expect(text).toContain('Merging is lossy and permanent; user messages stay verbatim.')
  })

  test('history report lists each user turn as a ready range with its size, prompt and tools, then the largest messages', () => {
    const t = new Transcript()
    t.prompt('read the config', 'm0001')
    t.call('Read', { file_path: '/etc/app.conf' }, { ref: 'm0002', output: 'x'.repeat(8000) })
    t.call('Bash', { command: 'ls', description: 'List files' }, { ref: 'm0003', output: 'y'.repeat(400) })
    t.call('Read', { file_path: '/b' }, { ref: 'm0004' })
    t.block(1, 'summary text')
    t.prompt('now fix it', 'm0005')
    const text = historyReport(t.rows, indexRows(t.rows), 0.25)
    expect(text).toMatch(/^- m0001\.\.m0004 ~2\.\dk "read the config"; Read×2, Bash$/m)
    expect(text).toMatch(/^- m0005 ~\d+ "now fix it"$/m)
    expect(text).toMatch(/^- m0002 ~2\.\dk Read: \/etc\/app\.conf$/m)
    expect(text).toMatch(/^- m0003 ~\d+ Bash: List files$/m)
    expect(text).not.toContain('b1')
  })

  test('history report breaks a turn at a compressed block, so no listed range spans one', () => {
    const t = new Transcript()
    t.prompt('go', 'm0001')
    t.block(1, 'summary text')
    t.call('Read', { file_path: '/a' }, { ref: 'm0002' })
    expect(historyReport(t.rows, indexRows(t.rows), 0.25)).toMatch(/^- m0002 ~\d+ \(continued\); Read$/m)
  })

  test('history report counts a row shared by parallel calls of one message once', () => {
    const t = new Transcript()
    t.prompt('go', 'm0001')
    t.call('Read', { file_path: '/a' }, { ref: 'm0002', output: 'x'.repeat(4000), msg: 'A' })
    t.call('Read', { file_path: '/b' }, { ref: 'm0003', output: 'y'.repeat(4000), msg: 'A' })
    const text = historyReport(t.rows, indexRows(t.rows), 0.25)
    const size = (ref: string) => Number(new RegExp(`^- ${ref} ~(\\d+\\.\\d)k`, 'm').exec(text)![1])
    expect(Math.abs(size('m0002') - size('m0003'))).toBeLessThan(0.1)
  })

  test('history report folds turns past the listed count into one line', () => {
    const t = new Transcript()
    for (let i = 1; i <= 17; i++) t.prompt(`p${i}`, `m${String(i).padStart(4, '0')}`)
    expect(historyReport(t.rows, indexRows(t.rows), 0.25)).toMatch(/^- \.\.\. 2 smaller turns, ~\d+ together$/m)
  })

  test('callLabel prefers the description, then the file, pattern or command, flattened and cut', () => {
    const call = (input: Record<string, any>) => ({ id: 'c', name: 'Bash', input, useRow: 0, isError: false, resultText: '', turn: 1 })
    expect(callLabel(call({ description: 'Run tests', command: 'make' }))).toBe('Bash: Run tests')
    expect(callLabel(call({ command: 'a\n  b' }))).toBe('Bash: a b')
    expect(callLabel(call({ command: 'x'.repeat(60) }))).toBe(`Bash: ${'x'.repeat(47)}…`)
    expect(callLabel(call({}))).toBe('Bash')
  })

  test('sizes follow the measured rate', () => {
    const blocks = new Map([[1, { row: 0, summary: 'x'.repeat(4000) }]])
    expect(blockReport(blocks, 0.5)).toContain('  - b1: ~2.0k')
    const t = new Transcript()
    t.prompt('small', 'm0001')
    t.call('Read', {}, { ref: 'm0002', output: 'x'.repeat(8000) })
    expect(historyReport(t.rows, indexRows(t.rows), 0.5)).toMatch(/^- m0002 ~4\.\dk Read$/m)
  })

  test('history report is empty when nothing is uncompressed', () => {
    const t = new Transcript()
    t.block(1, 'only a summary')
    expect(historyReport(t.rows, indexRows(t.rows), 0.25)).toBe('')
  })
})
