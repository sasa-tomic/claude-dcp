import { describe, expect, test } from 'claude-code/testing'

import { indexRows } from './model'
import { Transcript } from './rows.fixture'
import { PRUNED_COMPRESS_SUMMARY, PRUNED_STOP_FEEDBACK, staleReminders, PRUNED_TOOL_ERROR_INPUT, PRUNED_TOOL_OUTPUT, PRUNED_QUESTION_INPUT, applyPrunes, markPruned } from './strategies'
import { COMPRESS_TOOL } from './model'

const cfg = { deduplication: true, purgeErrors: true, purgeErrorsTurns: 2, protectedFilePatterns: ['**/*.env'] }

describe('deduplication', () => {
  test('prunes all but the latest of calls with identical tool and arguments, ignoring key order and null values', () => {
    const t = new Transcript()
    t.call('Read', { file_path: '/a', limit: null }, { id: 'c1' })
    t.call('Read', { limit: undefined, file_path: '/a' }, { id: 'c2' })
    t.call('Read', { file_path: '/a' }, { id: 'c3' })
    t.call('Read', { file_path: '/b' }, { id: 'c4' })
    expect([...markPruned(indexRows(t.rows), cfg)].sort()).toEqual(['c1', 'c2'])
  })

  test('keeps duplicates that touch protected file patterns, and does nothing when disabled', () => {
    const t = new Transcript()
    t.call('Read', { file_path: '/x/.env' }, { id: 'c1' })
    t.call('Read', { file_path: '/x/.env' }, { id: 'c2' })
    expect(markPruned(indexRows(t.rows), cfg).size).toBe(0)
    const u = new Transcript()
    u.call('Bash', { command: 'ls' }, { id: 'c1' })
    u.call('Bash', { command: 'ls' }, { id: 'c2' })
    expect(markPruned(indexRows(u.rows), { ...cfg, deduplication: false }).size).toBe(0)
  })
})

describe('purge errors', () => {
  function errored() {
    const t = new Transcript()
    t.call('Bash', { command: 'bad' }, { id: 'old', isError: true, output: 'boom' }) // turn 1
    t.call('Bash', { command: 'bad2' }, { id: 'new', isError: true, output: 'boom' }) // turn 2
    t.call('Read', { file_path: '/a' }, { id: 'ok' }) // turn 3
    return t
  }

  test('prunes failed calls at least purgeErrorsTurns old and never successful ones', () => {
    expect([...markPruned(indexRows(errored().rows), cfg)]).toEqual(['old'])
  })

  test('does nothing when disabled', () => {
    expect(markPruned(indexRows(errored().rows), { ...cfg, purgeErrors: false }).size).toBe(0)
  })
})

describe('compress calls', () => {
  test('marks answered compress calls whatever the options, but not failed, unanswered or already stubbed ones', () => {
    const t = new Transcript()
    const call = (id: string, summary: string, opts = {}) => t.call(COMPRESS_TOOL, { topic: 'T', content: [{ startId: 'm0001', endId: 'm0002', summary }] }, { id, ...opts })
    call('done', 'S')
    call('denied', 'S', { isError: true })
    call('stubbed', PRUNED_COMPRESS_SUMMARY)
    t.rows.push({ ...t.rows[0], uuid: 'pending', message: { id: 'p', role: 'assistant', content: [{ type: 'tool_use', id: 'pending', name: COMPRESS_TOOL, input: { content: [{ summary: 'S' }] } }] } })
    expect([...markPruned(indexRows(t.rows), { ...cfg, deduplication: false, purgeErrors: false })]).toEqual(['done'])
  })

  test('replaces each summary of a pruned compress call, keeping its boundaries', () => {
    const t = new Transcript()
    t.call(COMPRESS_TOOL, { topic: 'T', content: [{ startId: 'm0001', endId: 'm0002', summary: 'LONG', save: ['m0002'] }] }, { id: 'c' })
    expect(applyPrunes(t.rows, indexRows(t.rows), new Set(['c']))[0].message.content[0].input).toEqual({ topic: 'T', content: [{ startId: 'm0001', endId: 'm0002', summary: PRUNED_COMPRESS_SUMMARY, save: ['m0002'] }] })
  })
})

describe('applyPrunes', () => {
  test('replaces pruned outputs, error inputs and question inputs; leaves edit/write outputs and other calls alone', () => {
    const t = new Transcript()
    t.call('Read', { file_path: '/a' }, { id: 'r', output: 'BIG' }) // 0,1
    t.call('Bash', { command: 'x', timeout: 5 }, { id: 'e', isError: true, output: 'boom' }) // 2,3
    t.call('AskUserQuestion', { questions: ['q'] }, { id: 'q', output: 'answers' }) // 4,5
    t.call('Edit', { file_path: '/a' }, { id: 'ed', output: 'edited' }) // 6,7
    t.call('Read', { file_path: '/z' }, { id: 'keep', output: 'KEEP' }) // 8,9
    const out = applyPrunes(t.rows, indexRows(t.rows), new Set(['r', 'e', 'q', 'ed']))
    expect(out[1].message.content[0].content).toBe(PRUNED_TOOL_OUTPUT)
    expect(out[2].message.content[0].input).toEqual({ command: PRUNED_TOOL_ERROR_INPUT, timeout: 5 })
    expect(out[3].message.content[0].content).toBe('boom')
    expect(out[4].message.content[0].input.questions).toBe(PRUNED_QUESTION_INPUT)
    expect(out[5].message.content[0].content).toBe('answers')
    expect(out[7].message.content[0].content).toBe('edited')
    expect(out[9].message.content[0].content).toBe('KEEP')
    expect(t.rows[1].message.content[0].content).toBe('BIG')
  })
})

describe('stale reminders', () => {
  test("strips this plugin's nudges to their id and stubs its end-of-turn prompts; other hook context and feedback stay", () => {
    const t = new Transcript()
    const nudge = '<dcp-system-reminder>\nCompress now\n</dcp-system-reminder>'
    t.call('Read', { file_path: '/a' }, { ref: 'm0001' }) // 0 use, 1 result, 2 tag
    t.rows[2].attachment.content.unshift(nudge)
    t.rows[2].rendered = [{ content: `<system-reminder>\ntool.call hook additional context: ${nudge}\n<dcp-message-id>m0001</dcp-message-id>\n</system-reminder>` }]
    const feedback = (content: string) => t.rows.push({ ...t.rows[0], type: 'user', isMeta: true, message: { role: 'user', content } })
    feedback(`Stop hook feedback:\nEnd of turn. One ${COMPRESS_TOOL} call.`) // 3
    feedback('Stop hook feedback:\nRun the linter.') // 4
    t.call('Bash', { command: 'x' }, { ref: 'm0002' }) // 5, 6, 7 plain tag
    expect(staleReminders(t.rows)).toEqual([2, 3])
    const out = applyPrunes(t.rows, indexRows(t.rows), new Set())
    expect(out[2].attachment.content).toEqual(['<dcp-message-id>m0001</dcp-message-id>'])
    expect(out[2].rendered[0].content).toBe('<system-reminder>\ntool.call hook additional context: <dcp-message-id>m0001</dcp-message-id>\n</system-reminder>')
    expect(out[3].message.content).toBe(PRUNED_STOP_FEEDBACK)
    expect(out[4]).toBe(t.rows[4])
    expect(out[7]).toBe(t.rows[7])
    expect(t.rows[2].attachment.content[0]).toBe(nudge)
    expect(staleReminders(out)).toEqual([])
  })
})
