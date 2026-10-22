import { describe, expect, test } from 'claude-code/testing'

import { emptyStats, hashSignature, recordCall, recordFork, recordTurn, renderStats, savedTokens, type TurnUsage } from './stats'
import { TOOL, complete, compress, conversation, start, world } from './world.fixture'

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, ...over })

describe('recording', () => {
  test('a segment keeps its first turn apart and sums the rest', () => {
    const s = recordTurn(recordTurn(emptyStats(), 5000, usage({ cache_creation_input_tokens: 4000 })), 7000, usage())
    expect(s.segments).toEqual([{ removed: 0, before: undefined, turns: 2, first: 5000, last: 7000, peak: 7000, rewritten: 4000, uncached: 20, read: 2000, written: 4100, output: 40 }])
  })

  test('a fork opens a segment with what it removed and remembers the compressed calls, newest 2000 only', () => {
    const s = recordFork(recordTurn(emptyStats(), 9000, usage()), { removed: 3000, before: 9000, gone: ['a'] })
    expect(s.segments.map(x => [x.removed, x.before, x.turns])).toEqual([[0, undefined, 1], [3000, 9000, 0]])
    expect(savedTokens(s)).toBe(3000)
    const many = recordFork(s, { removed: 0, gone: Array.from({ length: 2500 }, (_, i) => `h${i}`) })
    expect(many.gone).toHaveLength(2000)
    expect(many.gone.at(-1)).toBe('h2499')
  })

  test('a call counts as repeated only when its signature was compressed away', () => {
    const s = recordFork(emptyStats(), { removed: 1, gone: [hashSignature('Read::{"file_path":"/a"}')] })
    expect(recordCall(s, hashSignature('Read::{"file_path":"/a"}')).refetches).toBe(1)
    expect(recordCall(s, hashSignature('Read::{"file_path":"/b"}'))).toBe(s)
  })
})

describe('/dcp-stats', () => {
  const run = ($: any) => $.command.run({ command: 'dcp-stats', args: '' })

  test('renders every segment and the billed tokens', () => {
    let s = recordTurn(emptyStats(), 80_000, usage({ cache_read_input_tokens: 900_000 }))
    s = recordFork(s, { removed: 40_000, before: 80_000, gone: [] })
    s = recordTurn(s, 45_000, usage({ cache_creation_input_tokens: 42_000 }))
    s = recordFork(s, { removed: 1, before: 1, gone: [] })
    expect(renderStats(s)).toBe(
      [
        '2 forks over 2 turns; about 40.0k tokens removed (estimate: characters / 4).',
        '0 calls repeated one compressed away (a proxy for lost information; a changed file counts too).',
        '',
        'Context per segment, first → last turn (peak), then what the fork that opened it did:',
        '1. 1 turn · 80.0k → 80.0k (peak 80.0k)',
        '2. 1 turn · 45.0k → 45.0k (peak 45.0k) · fork removed ~40.0k of 80.0k, first turn wrote 42.0k to the cache',
        '3. no turn yet',
        '',
        'Billed tokens: 20 uncached · 42.1k cache writes · 901.0k cache reads · 40 output.',
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
