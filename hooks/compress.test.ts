import { describe, expect, test } from 'claude-code/testing'

import { type CompressConfig, planCompression } from './compress'
import { indexRows } from './model'
import { Transcript } from './rows.fixture'

const cfg: CompressConfig = { protectedTools: ['Task'], protectedFilePatterns: ['**/*.env'], protectUserMessages: false, protectTags: false }
const range = (startId: string, endId: string, summary = 'S') => ({ startId, endId, summary })
const plan = (t: Transcript, content: ReturnType<typeof range>[], config = cfg) => planCompression(t.rows, indexRows(t.rows), { topic: 'T', content }, config)

function session() {
  const t = new Transcript()
  t.prompt('build X', 'm0001') // 0-1
  t.call('Read', { file_path: '/a' }, { ref: 'm0002', output: 'AAA' }) // 2-4
  t.call('Bash', { command: 'ls' }, { ref: 'm0003', output: 'BBB' }) // 5-7
  t.text('done') // 8
  t.prompt('next', 'm0004') // 9-10
  t.call('Edit', { file_path: '/b' }, { ref: 'm0005' }) // 11-13
  return t
}

describe('range resolution', () => {
  test('selects whole units from the start boundary to the end boundary', () => {
    const [p] = plan(session(), [range('m0001', 'm0003')])
    expect([p.s, p.e]).toEqual([0, 7])
    expect(p.finalSummary).toBe('S')
    expect(p.messageCount).toBe(3)
  })

  test('accepts ids copied with other case and surrounding space', () => {
    expect(plan(session(), [range(' M0002 ', 'm0003')])[0].s).toBe(2)
  })

  test('rejects malformed, unknown and reversed ids', () => {
    const t = session()
    expect(() => plan(t, [range('x', 'm0003')])).toThrow('startId "x" is not an ID (use mNNNN or bN)')
    expect(() => plan(t, [range('m0001', 'zz')])).toThrow('endId "zz" is not an ID')
    expect(() => plan(t, [range('m0001', 'm0099')])).toThrow('endId m0099 is not in the current context; use an ID you can see')
    expect(() => plan(t, [range('m0003', 'm0002')])).toThrow('startId m0003 comes after endId m0002')
  })

  test('validates content and topic', () => {
    const t = session()
    const idx = indexRows(t.rows)
    expect(() => planCompression(t.rows, idx, { topic: ' ', content: [range('m0001', 'm0002')] }, cfg)).toThrow('topic must be a non-empty string')
    expect(() => planCompression(t.rows, idx, { topic: 'T', content: [] }, cfg)).toThrow('content must be a non-empty array')
    expect(() => plan(t, [range('m0001', 'm0002', '  ')])).toThrow('content[0].summary must be a non-empty string')
  })

  test('rejects overlapping ranges in one batch', () => {
    expect(() => plan(session(), [range('m0001', 'm0003'), range('m0003', 'm0004')])).toThrow(
      'content[0] (m0001..m0003) overlaps content[1] (m0003..m0004); ranges in one call cannot overlap',
    )
  })

  test('widens the range so no tool call is split from its result', () => {
    const t = new Transcript()
    t.prompt('go', 'm0001') // 0-1
    t.rows.push({ ...t.rows[0], uuid: 'ua', type: 'assistant', message: { id: 'A', role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: {} }, { type: 'tool_use', id: 'c2', name: 'Read', input: {} }] } }) // 2
    const tag = (id: string, ref: string) => ({ ...t.rows[0], uuid: `t${id}`, type: 'attachment', attachment: { type: 'hook_additional_context', content: [`<dcp-message-id>${ref}</dcp-message-id>`], hookName: 'tool.call', toolUseID: `${id}-context` } })
    const result = (id: string) => ({ ...t.rows[0], uuid: `r${id}`, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] } })
    t.rows.push(result('c1'), tag('c1', 'm0002'), result('c2'), tag('c2', 'm0003')) // 3,4,5,6
    const [p] = plan(t, [range('m0002', 'm0002')])
    expect([p.s, p.e]).toEqual([2, 6])
  })
})

describe('block placeholders', () => {
  function withBlocks() {
    const t = new Transcript()
    t.block(1, 'first block') // 0
    t.block(2, 'second block') // 1
    t.prompt('go', 'm0001') // 2
    t.call('Read', {}, { ref: 'm0002' }) // 3-5
    return t
  }

  test('expands a required placeholder in place and consumes the block', () => {
    const [p] = plan(withBlocks(), [range('b1', 'm0001', 'Before (b1) after')])
    expect(p.finalSummary).toContain('Before first block after')
    expect(p.consumedBlockIds).toContain(1)
  })

  test('appends the summaries of required blocks the model left out', () => {
    const t = new Transcript()
    t.prompt('a', 'm0001')
    t.block(1, 'inner block')
    t.prompt('b', 'm0002')
    const [p] = plan(t, [range('m0001', 'm0002', 'Only new')])
    expect(p.finalSummary).toBe('Only new\n\nEarlier summaries inside this range:\n### (b1)\ninner block')
    expect(p.consumedBlockIds).toEqual([1])
  })

  test('drops duplicate, unknown and out-of-range placeholders', () => {
    const [p] = plan(withBlocks(), [range('b1', 'b2', '(b1) and (b1) and (b9)')])
    expect(p.finalSummary.match(/first block/g)?.length).toBe(1)
    expect(p.finalSummary).toContain('(b9)')
  })

  test('uses a block boundary id as the range edge and includes its summary', () => {
    const [p] = plan(withBlocks(), [range('b2', 'm0002', 'new')])
    expect(p.finalSummary).toContain('second block')
    expect(p.consumedBlockIds).toEqual([2])
  })
})

describe('protected content', () => {
  test('appends user messages verbatim when enabled, without their id tags', () => {
    const [p] = plan(session(), [range('m0001', 'm0004')], { ...cfg, protectUserMessages: true })
    expect(p.finalSummary).toContain('User messages in this range, verbatim:\nbuild X\nnext')
    expect(p.finalSummary).not.toContain('dcp-message-id')
  })

  test('appends <protect> prompt text when enabled', () => {
    const t = new Transcript()
    t.prompt('use <protect>always tabs</protect> ok', 'm0001')
    t.prompt('b', 'm0002')
    const [p] = plan(t, [range('m0001', 'm0002')], { ...cfg, protectTags: true })
    expect(p.finalSummary).toContain('Protected prompt text, verbatim:\nalways tabs')
  })

  test('appends outputs of protected tools and of calls touching protected files', () => {
    const t = new Transcript()
    t.prompt('go', 'm0001')
    t.call('Task', { description: 'x' }, { ref: 'm0002', output: 'AGENT REPORT' })
    t.call('Read', { file_path: '/p/.env' }, { ref: 'm0003', output: 'SECRET=1' })
    t.call('Read', { file_path: '/p/a.ts' }, { ref: 'm0004', output: 'plain' })
    const [p] = plan(t, [range('m0001', 'm0004')])
    expect(p.finalSummary).toContain('Protected tool outputs:\n### Tool: Task\nAGENT REPORT\n### Tool: Read\nSECRET=1')
    expect(p.finalSummary).not.toContain('plain')
  })

  test('adds nothing when the options are off and no protected tool ran', () => {
    expect(plan(session(), [range('m0001', 'm0004')])[0].finalSummary).toBe('S')
  })
})
