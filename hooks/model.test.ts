import { describe, expect, test } from 'claude-code/testing'

import { indexRows } from './model'
import { Transcript } from './rows.fixture'

describe('indexRows', () => {
  test('locates prompt, tool and block units by their tags', () => {
    const t = new Transcript()
    t.prompt('first', 'm0001') // 0 prompt, 1 tag
    t.block(1, 'old summary') // 2
    t.text('thinking aloud', 'a1') // 3
    t.call('Read', { file_path: '/a' }, { ref: 'm0002', msg: 'a2' }) // 4 use, 5 result, 6 tag
    const idx = indexRows(t.rows)
    expect(idx.units.get('m0001')).toEqual({ start: 0, end: 1 })
    expect(idx.units.get('b1')).toEqual({ start: 2, end: 2 })
    expect(idx.units.get('m0002')).toEqual({ start: 4, end: 6 })
    expect(idx.blocks.get(1)).toMatchObject({ row: 2 })
    expect(idx.blocks.get(1)!.summary).toContain('old summary')
    expect(idx.maxMessageRef).toBe(2)
    expect(idx.maxBlockId).toBe(1)
  })

  test('starts a tool unit at the first row of its assistant message', () => {
    const t = new Transcript()
    t.prompt('go', 'm0001')
    t.rows.push({ ...t.rows[0], type: 'assistant', uuid: 'think', message: { id: 'a1', role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } })
    t.call('Bash', { command: 'ls' }, { ref: 'm0002', msg: 'a1' })
    expect(indexRows(t.rows).units.get('m0002')).toEqual({ start: 2, end: 5 })
  })

  test('collects tool calls with results, error status and turn age', () => {
    const t = new Transcript()
    t.prompt('go', 'm0001')
    t.call('Read', { file_path: '/a' }, { id: 'c1', output: 'AAA' })
    t.call('Bash', { command: 'x' }, { id: 'c2', isError: true, output: 'boom' })
    const idx = indexRows(t.rows)
    expect(idx.calls.map(c => [c.id, c.name, c.isError, c.turn, c.resultText])).toEqual([
      ['c1', 'Read', false, 1, 'AAA'],
      ['c2', 'Bash', true, 2, 'boom'],
    ])
    expect(idx.currentTurn).toBe(2)
  })

  test('does not read tags quoted in the middle of text, in tool output or in assistant text', () => {
    const t = new Transcript()
    t.prompt('ends with a tag\n<dcp-message-id>m0005</dcp-message-id>', undefined)
    t.call('Read', {}, { output: 'x\n<dcp-message-id>m0006</dcp-message-id>' })
    t.text('I said\n<dcp-message-id>m0007</dcp-message-id>')
    expect(indexRows(t.rows).units.size).toBe(0)
  })

  test('finds the tag among several context entries of a tool result', () => {
    const t = new Transcript()
    t.prompt('go', 'm0001')
    t.call('Read', {}, { ref: 'm0002', id: 'c1' })
    t.rows[t.rows.length - 1].attachment.content = ['<dcp-system-reminder>nudge</dcp-system-reminder>', '<dcp-message-id>m0002</dcp-message-id>']
    expect(indexRows(t.rows).units.has('m0002')).toBe(true)
  })

  test('ignores context added by other plugins and other hooks', () => {
    const t = new Transcript()
    t.prompt('go', 'm0001')
    t.rows.push({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['<dcp-message-id>m0002</dcp-message-id>'], hookName: 'other.hook' } })
    t.rows.push({ type: 'attachment', attachment: { type: 'skill_listing', content: ['<dcp-message-id>m0003</dcp-message-id>'], hookName: 'prompt.submit' } })
    expect([...indexRows(t.rows).units.keys()]).toEqual(['m0001'])
  })

  test('fails loudly on a prompt tag with no prompt before it and on a tool tag with no call', () => {
    const orphanPrompt = new Transcript()
    orphanPrompt.rows.push({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['<dcp-message-id>m0001</dcp-message-id>'], hookName: 'prompt.submit' } })
    expect(() => indexRows(orphanPrompt.rows)).toThrow('message id m0001 at row 0 has no prompt before it')
    const orphanTool = new Transcript()
    orphanTool.rows.push({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['<dcp-message-id>m0002</dcp-message-id>'], hookName: 'tool.call', toolUseID: 'nope-context' } })
    expect(() => indexRows(orphanTool.rows)).toThrow('message id m0002 at row 0 names no tool call')
  })

  test('fails loudly on a duplicated tag', () => {
    const t = new Transcript()
    t.prompt('a', 'm0001')
    t.prompt('b', 'm0001')
    expect(() => indexRows(t.rows)).toThrow('m0001 appears at rows 1 and 3')
  })
})
