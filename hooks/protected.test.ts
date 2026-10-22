import { describe, expect, test } from 'claude-code/testing'

import { globMatches, isProtected } from './protected'

describe('globMatches', () => {
  test('* stays inside a path segment, ** crosses segments, **/ matches zero or more directories', () => {
    expect(globMatches('src/a.ts', 'src/*.ts')).toBe(true)
    expect(globMatches('src/x/a.ts', 'src/*.ts')).toBe(false)
    expect(globMatches('src/x/y/a.ts', 'src/**')).toBe(true)
    expect(globMatches('a.ts', '**/a.ts')).toBe(true)
    expect(globMatches('x/y/a.ts', '**/a.ts')).toBe(true)
    expect(globMatches('src/a.ts', 'src/?.ts')).toBe(true)
  })

  test('normalizes backslashes, escapes regex characters and needs a whole match', () => {
    expect(globMatches('src\\a.ts', 'src/a.ts')).toBe(true)
    expect(globMatches('a+b.ts', 'a+b.ts')).toBe(true)
    expect(globMatches('aab.ts', 'a+b.ts')).toBe(false)
    expect(globMatches('src/a.tsx', 'src/*.ts')).toBe(false)
    expect(globMatches('x', '')).toBe(false)
  })
})

describe('isProtected', () => {
  test('matches tool names exactly or by glob', () => {
    expect(isProtected('Task', {}, ['Task'], [])).toBe(true)
    expect(isProtected('mcp__x__y', {}, ['mcp__x__*'], [])).toBe(true)
    expect(isProtected('Read', {}, ['Task', 'mcp__*'], [])).toBe(false)
    expect(isProtected('Read', {}, [], [])).toBe(false)
  })

  test('protects a call whose file path argument matches a pattern', () => {
    expect(isProtected('Read', { file_path: '/p/secret.env' }, [], ['**/*.env'])).toBe(true)
    expect(isProtected('Edit', { notebook_path: '/p/x.ipynb' }, [], ['/p/*.ipynb'])).toBe(true)
    expect(isProtected('Read', { file_path: '/p/a.ts' }, [], ['**/*.env'])).toBe(false)
    expect(isProtected('Bash', { command: 'ls' }, [], ['**/*.env'])).toBe(false)
    expect(isProtected('Read', null, [], ['**/*.env'])).toBe(false)
  })
})
