import { describe, expect, test } from 'claude-code/testing'

import { assertAnswered, assertCurrent, parseTranscript, serializeTranscript } from './transcript'

const assistant = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })

describe('transcript text', () => {
  test('round-trips rows through JSONL', () => {
    const rows = [{ a: 1 }, { b: [2] }]
    expect(parseTranscript(serializeTranscript(rows), 'p')).toEqual(rows)
  })

  test('names the path and line of invalid JSON', () => {
    expect(() => parseTranscript('{"a":1}\nnot json\n', '/t.jsonl')).toThrow('/t.jsonl:2: invalid JSON')
  })
})

describe('assertCurrent', () => {
  test('accepts a transcript whose last assistant text is in the answer', () => {
    expect(() => assertCurrent([assistant('first'), assistant('final answer')], 'final answer', 'p')).not.toThrow()
  })

  test('rejects a transcript still ending before the answer', () => {
    expect(() => assertCurrent([assistant('first')], 'final answer', 'p')).toThrow('lags the session')
  })

  test('rejects a transcript with no assistant text', () => {
    expect(() => assertCurrent([{ type: 'user' }], 'x', 'p')).toThrow('lags the session')
  })
})

describe('assertAnswered', () => {
  const use = (id: string) => ({ type: 'assistant', message: { id: `a-${id}`, content: [{ type: 'tool_use', id, name: 'Read', input: {} }] } })
  const result = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })

  test('accepts a transcript whose every tool call has its result', () => {
    expect(() => assertAnswered([use('a'), result('a')], ['a'], 'p')).not.toThrow()
  })

  test('names the calls whose result the transcript does not hold yet', () => {
    expect(() => assertAnswered([use('a'), result('a'), use('b'), use('c')], [], 'p')).toThrow('p does not yet hold the results of b, c; it lags the session')
  })

  test('names a call the session ran that the transcript does not hold at all yet', () => {
    expect(() => assertAnswered([use('a'), result('a')], ['a', 'z'], 'p')).toThrow('p does not yet hold the results of z; it lags the session')
  })
})
