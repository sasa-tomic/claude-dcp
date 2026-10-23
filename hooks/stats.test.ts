import { describe, expect, test } from 'claude-code/testing'

import { emptyStats, hashSignature, isAwaitingFirst, recordCall, recordFirstRequest, recordFork, recordTurn, renderStats, savedTokens, type TurnUsage } from './stats'
import { TOOL, complete, compress, conversation, start, world } from './world.fixture'

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, ...over })

const fork = (over = {}) => ({ before: 9000, estimated: 3000, copied: 12, gone: [] as string[], ...over })

describe('recording', () => {
  test('a segment keeps its first turn apart and sums the rest', () => {
    const s = recordTurn(recordTurn(emptyStats(), 5000, usage({ cache_creation_input_tokens: 4000 })), 7000, usage())
    expect(s.segments).toEqual([{ removed: 0, before: undefined, turns: 2, first: 5000, last: 7000, peak: 7000, rewritten: 0, uncached: 20, read: 2000, written: 4100, output: 40 }])
  })

  test('a fork opens a segment that waits for its first request and remembers the compressed calls, newest 2000 only', () => {
    const s = recordFork(recordTurn(emptyStats(), 9000, usage()), fork({ gone: ['a'] }))
    expect(s.segments.map(x => [x.removed, x.before, x.estimated, x.copied, x.turns])).toEqual([[0, undefined, undefined, undefined, 1], [0, 9000, 3000, 12, 0]])
    expect(isAwaitingFirst(s)).toBe(true)
    expect(savedTokens(s)).toBe(0)
    const many = recordFork(s, fork({ gone: Array.from({ length: 2500 }, (_, i) => `h${i}`) }))
    expect(many.gone).toHaveLength(2000)
    expect(many.gone.at(-1)).toBe('h2499')
  })

  test('the first request after a fork settles what it removed: the context before minus what the API counted for that request', () => {
    const request = usage({ input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 4000 })
    const s = recordFirstRequest(recordFork(emptyStats(), fork()), request)
    expect(s.segments[1]).toMatchObject({ removed: 3995, first: 5005, rewritten: 4000 })
    expect(s.segments[1]).not.toHaveProperty('copied')
    expect(s.segments[1]).not.toHaveProperty('estimated')
    expect(isAwaitingFirst(s)).toBe(false)
    expect(savedTokens(s)).toBe(3995)
    expect(savedTokens(recordFirstRequest(recordFork(emptyStats(), fork({ before: 100 })), request))).toBe(-4905)
  })

  test('settling a fork that nothing waits for is an error', () => {
    expect(() => recordFirstRequest(emptyStats(), usage())).toThrow('no fork is waiting for its first request')
  })

  test('a call counts as repeated only when its signature was compressed away', () => {
    const s = recordFork(emptyStats(), fork({ gone: [hashSignature('Read::{"file_path":"/a"}')] }))
    expect(recordCall(s, hashSignature('Read::{"file_path":"/a"}')).refetches).toBe(1)
    expect(recordCall(s, hashSignature('Read::{"file_path":"/b"}'))).toBe(s)
  })
})

describe('/dcp-stats', () => {
  const run = ($: any) => $.command.run({ command: 'dcp-stats', args: '' })

  test('renders every segment, the fork that is not measured yet, and the billed tokens', () => {
    let s = recordTurn(emptyStats(), 80_000, usage({ cache_read_input_tokens: 900_000 }))
    s = recordFirstRequest(recordFork(s, fork({ before: 80_000, estimated: 35_000 })), usage({ input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 42_000 }))
    s = recordTurn(s, 45_000, usage())
    s = recordFork(s, fork({ before: 45_000, estimated: 3_000 }))
    expect(renderStats(s)).toBe(
      [
        '2 forks over 2 turns; 38.0k tokens removed (measured: the context before each fork minus the first request after it, which also holds your next prompt); 1 not measured yet.',
        '0 calls repeated one compressed away (a proxy for lost information; a changed file counts too).',
        '',
        'Context per segment, first → last turn (peak), then what the fork that opened it did:',
        '1. 1 turn · 80.0k → 80.0k (peak 80.0k)',
        '2. 1 turn · 42.0k → 45.0k (peak 45.0k) · fork removed 38.0k of 80.0k, its first request wrote 42.0k to the cache',
        '3. fork estimated at ~3.0k, not measured until its first request',
        '',
        'Billed tokens: 20 uncached · 200 cache writes · 901.0k cache reads · 40 output.',
      ].join('\n'),
    )
  })

  test('counts the turns of the session and the repeats of calls a fork compressed away, not those of subagents', async ($, on) => {
    const { clock } = world(on, { tokens: 100, rows: () => conversation().rows, session: { id: 'old-id', switchOnResume: true } })
    await start($)
    await complete($, 'all done', usage())
    await compress($, [{ startId: 'm0001', endId: 'm0003', summary: 'GOAL: did the thing' }])
    await complete($)
    await clock.advance(1000)
    await $.tool.call({ tool: 'Read', file_path: '/a' })
    await $.tool.call({ tool: 'Read', file_path: '/other' })
    await $.tool.call({ tool: 'Read', file_path: '/a', agentId: 'sub' } as any)
    const text = (await run($)).text
    expect(text).toContain('1 fork over 1 turn;')
    expect(text).toContain('1 call repeated one compressed away')
  })

  test('ignores a turn that counted nothing', async ($, on) => {
    world(on, { tokens: 100, rows: () => conversation().rows })
    await start($)
    await complete($)
    expect((await run($)).text).toContain('0 forks over 0 turns;')
  })
})
