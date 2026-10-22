import { describe, expect, test } from 'claude-code/testing'

import { indexRows } from './model'
import { approxTokens, blockReport, estimateRowsTokens, estimateTokens, formatTokens, messageReport, resolveLimit } from './nudges'
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
  test('estimates 4 characters per token and formats thousands with one decimal', () => {
    expect(estimateTokens('x'.repeat(401))).toBe(100)
    expect(approxTokens(950)).toBe('~950')
    expect(approxTokens(12345)).toBe('~12.3k')
  })
})

describe('conversation size', () => {
  test('formats exact token counts without a tilde', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(62300)).toBe('62.3k')
  })

  test('estimates only the message content of user and assistant rows', () => {
    const t = new Transcript()
    t.prompt('x'.repeat(400))
    t.call('Read', {}, { output: 'y'.repeat(800) })
    t.rows.push({ type: 'queue-operation', content: 'z'.repeat(8000) })
    const tokens = estimateRowsTokens(t.rows)
    expect(tokens).toBeGreaterThan(300)
    expect(tokens).toBeLessThan(400)
  })
})

describe('reports', () => {
  test('block report with no blocks is one line', () => {
    expect(blockReport(new Map())).toBe('Compressed blocks: 0 (none)')
  })

  test('block report lists the largest blocks, their total and the order of preference', () => {
    const blocks = new Map(Array.from({ length: 10 }, (_, i) => [i + 1, { row: i, summary: 'x'.repeat((i + 1) * 4000) }] as const))
    const text = blockReport(blocks)
    expect(text).toContain('Compressed blocks: 10 (b1, b2, b3, b4, b5, b6, b7, b8, b9, b10)')
    expect(text).toContain('  - b10: ~10.0k\n  - b9: ~9.0k')
    expect(text).toContain('  - ... +2 smaller')
    expect(text).toContain('~55.0k in total')
    expect(text).toContain('1. Drop ranges you no longer need.')
    expect(text).toContain('(e.g. b1..b8)')
    expect(text).toContain('Merging is lossy and permanent.')
  })

  test('message report names the largest uncompressed messages with their tool output counts', () => {
    const t = new Transcript()
    t.prompt('small', 'm0001')
    t.call('Read', {}, { ref: 'm0002', output: 'x'.repeat(8000) })
    t.call('Bash', {}, { ref: 'm0003', output: 'y'.repeat(400) })
    t.block(1, 'summary text')
    const text = messageReport(t.rows, indexRows(t.rows))
    expect(text.split('\n')[0]).toContain('Largest uncompressed messages')
    expect(text).toMatch(/^- m0002 assistant ~2\.\dk, 1 tool output$/m)
    expect(text.indexOf('m0002')).toBeLessThan(text.indexOf('m0003'))
    expect(text).not.toContain('b1')
  })

  test('message report is empty when nothing is uncompressed', () => {
    const t = new Transcript()
    t.block(1, 'only a summary')
    expect(messageReport(t.rows, indexRows(t.rows))).toBe('')
  })
})
