import { describe, expect, test } from 'claude-code/testing'

import { gitToolPath, homeOf } from './platform'

describe('Windows support', () => {
  test('uses HOME where it is set and USERPROFILE where it is not, which is Windows', () => {
    expect(homeOf({ HOME: '/home/u', USERPROFILE: 'C:\\Users\\u' })).toBe('/home/u')
    expect(homeOf({ USERPROFILE: 'C:\\Users\\u' })).toBe('C:\\Users\\u')
    expect(homeOf({ HOME: '', USERPROFILE: 'C:\\Users\\u' })).toBe('C:\\Users\\u')
  })

  test('fails loudly instead of building an `undefined/.claude` path when no home is known', () => {
    expect(() => homeOf({})).toThrow('neither HOME nor USERPROFILE')
  })

  test('finds a Linux tool in the first Git for Windows install that has it', async () => {
    const present = new Set(['C:\\Program Files\\Git\\usr\\bin\\grep.exe', 'D:\\Tools\\Git\\usr\\bin\\dd.exe'])
    const exists = async (path: string) => present.has(path)
    expect(await gitToolPath('grep', [undefined, 'C:\\Program Files', 'D:\\Tools'], exists)).toBe('C:\\Program Files\\Git\\usr\\bin\\grep.exe')
    expect(await gitToolPath('dd', ['C:\\Program Files', 'D:\\Tools'], exists)).toBe('D:\\Tools\\Git\\usr\\bin\\dd.exe')
  })

  test('reports no path when Git for Windows is not installed, so the plain name is used', async () => {
    expect(await gitToolPath('grep', ['C:\\Program Files', undefined], async () => false)).toBeUndefined()
    expect(await gitToolPath('grep', [], async () => true)).toBeUndefined()
  })
})
