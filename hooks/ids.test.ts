import { describe, expect, test } from 'claude-code/testing'

import { blockRef, loneRef, messageRef, parseRef, tagLine, trailingRef } from './ids'

describe('refs', () => {
  test('formats message refs as m + 4 digits and block refs as b + number', () => {
    expect(messageRef(7)).toBe('m0007')
    expect(blockRef(12)).toBe('b12')
  })

  test('grows past four digits instead of running out at m9999', () => {
    expect(messageRef(10000)).toBe('m10000')
    expect(parseRef('m10000')).toEqual({ ref: 'm10000', number: 10000 })
    expect(trailingRef(`x${tagLine('m10000')}`)).toBe('m10000')
  })

  test('rejects invalid message and block numbers', () => {
    expect(() => messageRef(0)).toThrow('Invalid message number: 0')
    expect(() => blockRef(0)).toThrow('Invalid block number')
  })

  test('parses refs case-insensitively and rejects everything else', () => {
    expect(parseRef(' M0012 ')).toEqual({ ref: 'm0012', number: 12 })
    expect(parseRef('b3')).toEqual({ ref: 'b3', block: 3 })
    expect(parseRef('m00012')).toBeNull() // one spelling per id: no padding past four digits
    for (const bad of ['m12', 'm0000', 'b0', 'x1', '', '<dcp-message-id>m0001</dcp-message-id>']) expect(parseRef(bad)).toBeNull()
  })
})

describe('tags', () => {
  test('puts the tag on its own line', () => {
    expect(tagLine('m0001')).toBe('\n<dcp-message-id>m0001</dcp-message-id>')
  })

  test('reads a tag only when it ends the text', () => {
    expect(trailingRef(`hello${tagLine('m0004')}`)).toBe('m0004')
    expect(trailingRef(`see <dcp-message-id>m0004</dcp-message-id> in the middle\nmore`)).toBeNull()
    expect(trailingRef('no tag')).toBeNull()
  })

  test('loneRef accepts exactly one tag and nothing around it', () => {
    expect(loneRef('<dcp-message-id>m0009</dcp-message-id>')).toBe('m0009')
    expect(loneRef('x <dcp-message-id>m0009</dcp-message-id>')).toBeNull()
    expect(loneRef('<dcp-system-reminder>n</dcp-system-reminder>')).toBeNull()
  })
})
