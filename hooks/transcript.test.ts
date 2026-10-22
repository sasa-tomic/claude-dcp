import { describe, expect, test } from 'claude-code/testing'

import { assertCurrent, parseTranscript, serializeTranscript } from './transcript'

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
