import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { CWD, HOME, ID, LOG, PROJECTS, SRC, STATUS, TOOL, clones, complete, compress, conversation, start, submit, world } from './world.fixture'
import type { World } from './world.fixture'
import { indexRows } from './model'
import { emptyStats, recordFirstRequest, recordFork, type TurnUsage } from './stats'
import { Transcript } from './rows.fixture'
import { parseTranscript, serializeTranscript } from './transcript'

describe('session.start', () => {
  test('registers the compress tool with the DCP description, schema and its schema in the tool list', async ($, on) => {
    const { seen } = world(on, { rows: () => conversation().rows })
    await start($)
    const [spec] = seen.tools
    expect(spec.name).toBe('compress')
    expect(spec.isDeferred).toBe(false)
    expect(spec.description.startsWith('Replace spans of the conversation with summaries.')).toBe(true)
    expect(spec.inputSchema.required).toEqual(['topic', 'content'])
    expect(spec.inputSchema.properties.content.items.required).toEqual(['startId', 'endId', 'summary'])
  })

  test('a headless run (-p, SDK) gets no tool, system prompt, id tag or stop hold-back unless DCP_HEADLESS=1', async ($, on) => {
    const { seen } = world(on, { tokens: 30000, rows: () => conversation().rows })
    await start($, false)
    await $.tool.call({ tool: 'Read', file_path: '/x' })
    const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
    expect(seen.tools).toEqual([])
    expect(seen.commands).toEqual([])
    expect(sections.map((s: any) => s.id)).toEqual(['base'])
    expect((await submit($)).context).toBeUndefined()
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  })

  test('DCP_HEADLESS=1 makes a headless run use dcp as an interactive one does', async ($, on) => {
    const { seen } = world(on, { rows: () => conversation().rows, env: { DCP_HEADLESS: '1' } })
    await start($, false)
    expect(seen.tools.map((t: any) => t.name)).toEqual(['compress'])
  })

  test('continues message numbering after the highest id in an existing transcript', async ($, on) => {
    world(on, { rows: () => conversation().rows })
    await start($)
    expect(await submit($)).toMatchObject({ text: 'hi', context: ['<dcp-message-id>m0004</dcp-message-id>'] })
  })

  test('continues after the highest id when the transcript could not be found at session start but exists by the first prompt', async ($, on) => {
    const w: World = { rows: () => conversation().rows, exists: false }
    world(on, w)
    await start($)
    w.exists = true
    expect(await submit($)).toMatchObject({ context: ['<dcp-message-id>m0004</dcp-message-id>'] })
    expect((await $.tool.call({ tool: 'Read', file_path: '/x' })).context).toContain('<dcp-message-id>m0005</dcp-message-id>')
  })

  test('starts numbering at 1 for a session without a transcript yet', async ($, on) => {
    const { seen } = world(on, { rows: () => [], exists: false })
    await start($)
    expect(await submit($)).toMatchObject({ text: 'hi', context: ['<dcp-message-id>m0001</dcp-message-id>'] })
    expect(seen.writes[LOG]).toContain('no transcript for session old-id yet: numbering messages from 1')
  })
})

describe('finding the transcript', () => {
  test('finds it by session id in whichever project folder holds it, not by the current directory', async ($, on) => {
    world(on, { tokens: 160000, rows: () => conversation().rows })
    await start($)
    const { context } = await $.tool.call({ tool: 'Read', file_path: '/x' })
    expect(context![0]).toContain('Context is at or over the maximum limit.')
  })

  test('reports loudly when no project folder holds the session transcript', async ($, on) => {
    const { seen } = world(on, { tokens: 160000, rows: () => conversation().rows, exists: false })
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/x' })
    expect(seen.toasts[0]).toBe('dcp: no transcript found for session old-id')
    expect(seen.writes[LOG]).toContain('ERROR dcp: no transcript found for session old-id')
  })
})

describe('prompt.compose', () => {
  test('adds the DCP system prompt with the registered tool name and protected tools after the base prompt', async ($, on) => {
    world(on, { rows: () => [] })
    await start($)
    const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    const dcp = sections.at(-1)!
    expect(sections[0].id).toBe('base')
    expect(dcp.id).toBe('dcp:system')
    expect(dcp.scope).toBe('session')
    expect(dcp.text).toContain('mcp__dcp__compress is your only context tool')
    expect(dcp.text).toContain('The environment keeps the outputs of `Task`, `Agent`, `Skill`, `TodoWrite` through compression.')
  })
})

describe('prompt.submit', () => {
  test('tags each prompt with the next message id as hidden context, leaving its text alone', async ($, on) => {
    world(on, { rows: () => [], exists: false })
    await start($)
    expect(await submit($, 'a')).toMatchObject({ text: 'a', context: ['<dcp-message-id>m0001</dcp-message-id>'] })
    expect(await submit($, 'b')).toMatchObject({ text: 'b', context: ['<dcp-message-id>m0002</dcp-message-id>'] })
  })

  test('leaves slash commands and meta prompts untagged', async ($, on) => {
    world(on, { rows: () => [], exists: false })
    await start($)
    expect((await submit($, '/clear', { command: { name: 'clear', args: '' } })).context ?? []).toEqual([])
    expect((await submit($, 'meta', { isMeta: true })).context ?? []).toEqual([])
  })

  test('attaches only the id tag, whatever the context size: the end-of-turn stop hook does the nudging', async ($, on) => {
    world(on, { tokens: 160000, rows: () => conversation().rows })
    await start($)
    expect((await submit($)).context).toEqual(['<dcp-message-id>m0004</dcp-message-id>'])
  })
})

describe('tool.call tagging and nudges', () => {
  test('adds the next message id tag to a tool result as hidden context', async ($, on) => {
    world(on, { tokens: 100, rows: () => conversation().rows })
    await start($)
    const r = await $.tool.call({ tool: 'Read', file_path: '/x' })
    expect(r.context).toEqual(['<dcp-message-id>m0004</dcp-message-id>'])
  })

  test('leaves subagent tool calls alone', async ($, on) => {
    world(on, { tokens: 100, rows: () => conversation().rows })
    await start($)
    expect((await $.tool.call({ tool: 'Read', file_path: '/x', agentId: 'sub' } as any)).context).toBeUndefined()
  })

  test('denies the compress tool to a subagent with the reason, instead of the engine\'s missing-hook error', async ($, on) => {
    world(on, { tokens: 100, rows: () => conversation().rows })
    await start($)
    const r = await $.tool.call({ tool: TOOL, topic: 'T', content: [], agentId: 'sub' } as any)
    expect(r.deny).toBe("mcp__dcp__compress is for the main conversation only; a subagent's messages carry no ids.")
  })

  test('over the max limit, sends the emergency nudge first and then every nudgeFrequency results', async ($, on) => {
    world(on, { tokens: 160000, rows: () => conversation().rows })
    await start($)
    const contexts = []
    for (let i = 0; i < 6; i++) contexts.push((await $.tool.call({ tool: 'Read', file_path: '/x' })).context!)
    expect(contexts.map(c => c.length)).toEqual([2, 1, 1, 1, 1, 2])
    expect(contexts[0][0]).toContain('Context is at or over the maximum limit.')
    expect(contexts[0][0]).toContain('Call mcp__dcp__compress now.')
    expect(contexts[1][0]).toMatch(/^<dcp-message-id>/)
  })

  test('sends no nudge while the engine still counts the old session: the last fork has not seen its first request', async ($, on) => {
    world(on, { tokens: 160000, rows: () => conversation().rows, store: { 'stats2:old-id': recordFork(emptyStats(), { before: 1, estimated: 1, copied: 1, gone: [] }) } })
    await start($)
    expect((await $.tool.call({ tool: 'Read', file_path: '/x' })).context).toHaveLength(1)
  })

  test('sends no nudge while the conversation has no two answered requests to size its messages by', async ($, on) => {
    const t = new Transcript()
    t.prompt('goal', 'm0001')
    t.call('Read', { file_path: '/a' }, { ref: 'm0002', output: 'AAA' })
    world(on, { tokens: 160000, rows: () => t.rows })
    await start($)
    expect((await $.tool.call({ tool: 'Read', file_path: '/x' })).context).toHaveLength(1)
  })

  test('under the max limit, sends no nudge however many results followed the prompt', async ($, on) => {
    world(on, { tokens: 120000, rows: () => conversation().rows })
    await start($)
    const counts = []
    for (let i = 0; i < 16; i++) counts.push((await $.tool.call({ tool: 'Read', file_path: '/x' })).context!.length)
    expect(counts).toEqual(Array(16).fill(1))
  })
})

describe('compress tool', () => {
  const summary = (startId: string, endId: string) => [{ startId, endId, summary: 'did the thing' }]

  test('queues a valid range and answers like DCP', async ($, on) => {
    world(on, { tokens: 100, rows: () => conversation().rows })
    await start($)
    const r = await compress($, summary('m0001', 'm0003'))
    expect(r.result).toBe('Compressed 3 messages into [Compressed conversation section].')
    expect(r.context).toEqual(['<dcp-message-id>m0004</dcp-message-id>'])
  })

  test('under the min limit, denies a summary longer than a stub so nothing is paraphrased', async ($, on) => {
    world(on, { tokens: 99000, rows: () => conversation().rows })
    await start($)
    const r = await compress($, [{ startId: 'm0001', endId: 'm0003', summary: 'x'.repeat(201) }])
    expect(r.deny).toBe('Context is 99.0k, under the 100000 limit: summaries must be stubs of at most 200 characters (what was dropped and why). m0001..m0003 has 201.')
    expect((await compress($, [{ startId: 'm0001', endId: 'm0003', summary: 'x'.repeat(200) }])).result).toContain('Compressed')
  })

  test('from the min limit up, accepts a full summary', async ($, on) => {
    world(on, { tokens: 100000, rows: () => conversation().rows })
    await start($)
    expect((await compress($, [{ startId: 'm0001', endId: 'm0003', summary: 'x'.repeat(5000) }])).result).toContain('Compressed')
  })

  test('denies an invalid range with the DCP error so the model can retry', async ($, on) => {
    world(on, { tokens: 100, rows: () => conversation().rows })
    await start($)
    const r = await compress($, summary('m0003', 'm0002'))
    expect(r.deny).toBe('startId m0003 comes after endId m0002')
  })

  test('denies a range overlapping one already queued this turn', async ($, on) => {
    world(on, { tokens: 100, rows: () => conversation().rows })
    await start($)
    await compress($, summary('m0001', 'm0002'))
    const r = await compress($, summary('m0002', 'm0003'))
    expect(r.deny).toContain('ranges in one call cannot overlap')
  })

  test('waits for the transcript to catch up before declaring an id unavailable', async ($, on) => {
    const t = conversation()
    const { clock } = world(on, { tokens: 100, rows: () => t.rows })
    await start($)
    const call = compress($, summary('m0001', 'm0004'))
    await clock.advance(1000)
    t.call('Read', {}, { ref: 'm0004' })
    await clock.advance(1000)
    expect((await call).result).toContain('Compressed')
  })

  test('denies an id that never appears after the attempts', async ($, on) => {
    const { clock } = world(on, { tokens: 100, rows: () => conversation().rows })
    await start($)
    const call = compress($, summary('m0001', 'm0099'))
    await clock.advance(10_000)
    expect((await call).deny).toContain('endId m0099 is not in the current context')
  })
})

const measured = (before: number, first: number) =>
  recordFirstRequest(recordFork(emptyStats(), { before, estimated: 0, copied: 1, gone: [] }), { input_tokens: first, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })

describe('turn.complete', () => {
  async function queued($: any, on: On, rowsOf = () => conversation().rows, session?: { id: string; switchOnResume?: boolean }) {
    const w = world(on, { tokens: 100, rows: rowsOf, session })
    await start($)
    await compress($, [{ startId: 'm0001', endId: 'm0003', summary: 'GOAL: did the thing' }])
    return w
  }

  test('forks the transcript with the range replaced by its summary, strategies applied, and resumes it', async ($, on) => {
    const t = conversation()
    t.call('Read', { file_path: '/a' }, { ref: 'm0004', output: 'AAA again' }) // duplicate of m0002's call, outside the range
    const { clock, seen } = await queued($, on, () => t.rows)
    await complete($)
    await clock.advance(1000)
    const [path] = clones(seen)
    const forkId = path.split('/').pop()!.replace('.jsonl', '')
    const rows = parseTranscript(seen.writes[path], path)
    expect(clones(seen)).toHaveLength(1)
    expect(rows[0].message.content).toContain('[Compressed conversation section]\nGOAL: did the thing')
    expect(indexRows(rows).blocks.has(1)).toBe(true)
    expect(rows.every((r: any) => r.sessionId === forkId)).toBe(true)
    expect(seen.resumes).toEqual([`resume ${forkId}`])
    expect(seen.writes[LOG]).toContain('1 ranges compressed, 1 tool calls pruned')
  })

  const bigConversation = () => {
    const t = new Transcript()
    t.prompt('goal', 'm0001')
    t.call('Read', { file_path: '/a' }, { ref: 'm0002', output: 'A'.repeat(4000) })
    t.call('Bash', { command: 'ls' }, { ref: 'm0003', output: 'B'.repeat(4000) })
    t.text('all done')
    return t
  }

  test('after the switch, toasts the saving and pins it for the new session, not before', async ($, on) => {
    const t = bigConversation()
    const session = { id: ID, switchOnResume: true }
    const { clock, seen } = await queued($, on, () => t.rows, session)
    await complete($)
    expect(seen.toasts).toEqual([])
    expect(seen.statuses.filter(s => s?.startsWith('compressed'))).toEqual([])
    await clock.advance(1000)
    expect(seen.toasts).toHaveLength(1)
    expect(seen.toasts[0]).toMatch(/^dcp: compressed 1 range\(s\), pruned 0 tool call\(s\): ~2\.\dk removed \(estimated; measured at the next reply\)$/)
    expect(seen.statuses.at(-1)).toMatch(/^compressed ~2\.\dk \(estimate\)$/)
    expect(session.id).not.toBe(ID)
    expect(seen.writes[`${HOME}/.claude/dcp-status-${session.id}`]).toBe(seen.statuses.at(-1))
    expect(seen.writes[LOG]).toMatch(/~2\.\dk removed \(estimated; measured at the next reply\), cache rewrite ~\d+/)
    expect(seen.shell).toContainEqual(['rm', '-f', '--', STATUS])
  })


  test('a fork that would remove far less than it makes the cache rewrite waits, queue and all', async ($, on) => {
    const t = tailHeavy()
    const { clock, seen } = world(on, { tokens: 100, rows: () => t.rows })
    await start($)
    await compress($, [{ startId: 'm0002', endId: 'm0002', summary: 'read' }])
    await complete($)
    await clock.advance(1000)
    expect(clones(seen)).toEqual([])
    expect(seen.resumes).toEqual([])
    expect(seen.writes[LOG]).toMatch(/fork waits: it would remove ~\d+ and make the cache rewrite ~2\.\dk \(minRemovedShare 0\.5\)/)
    await compress($, [{ startId: 'm0003', endId: 'm0003', summary: 'listing' }])
    await complete($)
    expect(clones(seen)).toHaveLength(1)
  })

  test('a fork of a conversation with no two answered requests to size it by fails loudly and does not switch', async ($, on) => {
    const t = new Transcript()
    t.prompt('goal', 'm0001')
    t.text('all done')
    const { seen } = world(on, { tokens: 100, rows: () => t.rows })
    await start($)
    await compress($, [{ startId: 'm0001', endId: 'm0001', summary: 'goal' }])
    await complete($)
    expect(seen.toasts.at(-1)).toBe('dcp: the conversation has no two consecutive answered requests to measure its tokens per character on')
    expect(seen.resumes).toEqual([])
  })

  test('a fork over the max limit is made however little it removes', async ($, on) => {
    const t = tailHeavy()
    const { clock, seen } = world(on, { tokens: 160000, rows: () => t.rows })
    await start($)
    await compress($, [{ startId: 'm0002', endId: 'm0002', summary: 'read' }])
    await complete($)
    await clock.advance(1000)
    expect(clones(seen)).toHaveLength(1)
  })

  test('puts the unsent draft back in the prompt box once the switch happened, not before', async ($, on) => {
    const session = { id: ID, switchOnResume: true }
    const { clock, seen } = world(on, { tokens: 100, rows: () => conversation().rows, session, draft: 'half-typed message' })
    await start($)
    await compress($, [{ startId: 'm0001', endId: 'm0003', summary: 'done' }])
    await complete($)
    expect(seen.fills).toEqual([])
    await clock.advance(1000)
    expect(seen.fills).toEqual(['half-typed message'])
  })

  test('leaves the box alone when there was no draft', async ($, on) => {
    const session = { id: ID, switchOnResume: true }
    const { clock, seen } = world(on, { tokens: 100, rows: () => conversation().rows, session })
    await start($)
    await compress($, [{ startId: 'm0001', endId: 'm0003', summary: 'done' }])
    await complete($)
    await clock.advance(1000)
    expect(seen.fills).toEqual([])
  })

  test('reports loudly, with the draft, when the box does not take it back', async ($, on) => {
    const session = { id: ID, switchOnResume: true }
    const { clock, seen } = world(on, { tokens: 100, rows: () => conversation().rows, session, draft: 'half-typed message', fillRefusal: 'dialog' })
    await start($)
    await compress($, [{ startId: 'm0001', endId: 'm0003', summary: 'done' }])
    await complete($)
    await clock.advance(1000)
    expect(seen.toasts.at(-1)).toBe('dcp: could not put the unsent draft back after the switch (refused by a hook); it was: half-typed message')
  })

  test('reports growth when the summary is larger than what it replaces', async ($, on) => {
    const session = { id: ID, switchOnResume: true }
    const { clock, seen } = world(on, { tokens: 160000, rows: () => conversation().rows, session })
    await start($)
    await compress($, [{ startId: 'm0002', endId: 'm0002', summary: 'verbose '.repeat(500) }])
    await complete($)
    await clock.advance(1000)
    expect(seen.toasts[0]).toMatch(/: ~\d+ added \(estimated/)
  })

  const answered = (usage: Partial<TurnUsage>) => ({ type: 'assistant', uuid: 'new1', parentUuid: null, sessionId: 's', message: { id: 'new', role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage } })
  const turnUsage = (over: Partial<TurnUsage> = {}): TurnUsage => ({ input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, ...over })

  test("the first reply after the switch settles the fork from the API's count of its first request, and the total stays for later turns", async ($, on) => {
    const t = bigConversation()
    const session = { id: ID, switchOnResume: true }
    const placeholder = { ...answered(turnUsage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })), message: { id: 'synthetic', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }], usage: turnUsage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) } }
    const w = world(on, { tokens: 100, rows: () => t.rows, session, appended: [placeholder, answered(turnUsage())] })
    await start($)
    await compress($, [{ startId: 'm0001', endId: 'm0003', summary: 'GOAL: did the thing' }])
    await complete($)
    await w.clock.advance(1000)
    await complete($, 'anything', turnUsage())
    expect(w.seen.statuses.at(-1)).toBe('context 100 / 200.0k (0%) · saved 45 so far')
    expect((await ($ as any).command.run({ command: 'dcp-stats', args: '' })).text).toContain('fork removed 45 of 100, its first request wrote 30 to the cache')
    await complete($, 'again', turnUsage())
    expect(w.seen.statuses.at(-1)).toBe('context 100 / 200.0k (0%) · saved 45 so far')
  })

  test('a counted reply with no answered request in the forked transcript is an error, not a guess', async ($, on) => {
    const t = bigConversation()
    const session = { id: ID, switchOnResume: true }
    const w = world(on, { tokens: 100, rows: () => t.rows, session })
    await start($)
    await compress($, [{ startId: 'm0001', endId: 'm0003', summary: 'GOAL: did the thing' }])
    await complete($)
    await w.clock.advance(1000)
    const done = complete($, 'anything', turnUsage())
    for (let i = 0; i < 10; i++) await w.clock.advance(500)
    await done
    expect(w.seen.toasts.at(-1)).toMatch(/^dcp: no answered request after the \d+ rows the fork copied$/)
  })

  test('with nothing queued, pins the real context size and the saving so far, per session', async ($, on) => {
    const { seen } = world(on, { tokens: 62300, rows: () => conversation().rows, store: { 'stats2:old-id': measured(5000, 2500), 'stats2:other': measured(999999, 1) } })
    await start($)
    await complete($)
    expect(seen.statuses.at(-1)).toBe('context 62.3k / 200.0k (31%) · saved 2.5k so far')
    expect(seen.writes[STATUS]).toBe(seen.statuses.at(-1))
  })

  test('ignores stats stored by an earlier version of the plugin under the old key', async ($, on) => {
    world(on, { tokens: 100, rows: () => conversation().rows, store: { 'stats:old-id': measured(5000, 2500) } })
    await start($)
    expect((await ($ as any).command.run({ command: 'dcp-stats', args: '' })).text).toContain('0 forks over 0 turns; 0 tokens removed')
  })

  test('with nothing saved yet, shows 0', async ($, on) => {
    const { seen } = world(on, { tokens: 62300, rows: () => conversation().rows })
    await start($)
    await complete($)
    expect(seen.statuses.at(-1)).toBe('context 62.3k / 200.0k (31%) · saved 0 so far')
  })

  test('with nothing queued and no response yet, pins nothing', async ($, on) => {
    const { seen } = world(on, { rows: () => conversation().rows })
    await start($)
    await complete($)
    expect(seen.statuses).toEqual([])
    expect(seen.writes[STATUS]).toBeUndefined()
  })

  test('logs a switch that happened', async ($, on) => {
    const { clock, seen } = await queued($, on, undefined, { id: ID, switchOnResume: true })
    await complete($)
    await clock.advance(1000)
    expect(seen.writes[LOG]).toMatch(/now in [0-9a-f-]{36}, forked from old-id/)
    expect(seen.toasts.filter(t => t.includes('did not happen'))).toEqual([])
  })

  test('reports a resume that left the session where it was', async ($, on) => {
    const { clock, seen } = await queued($, on)
    await complete($)
    await clock.advance(1000)
    expect(seen.toasts.at(-1)).toMatch(/^dcp: switch to [0-9a-f-]{36} did not happen; session is old-id$/)
  })

  test("keeps each session's queue to itself", async ($, on) => {
    const session = { id: ID }
    const { clock, seen } = await queued($, on, undefined, session)
    session.id = 'someone-else'
    await complete($)
    await clock.advance(1000)
    expect(clones(seen)).toEqual([])
    expect(seen.resumes).toEqual([])
    session.id = ID
    await complete($)
    await clock.advance(1000)
    expect(clones(seen)).toHaveLength(1)
  })

  test('with nothing queued, does nothing', async ($, on) => {
    const { clock, seen } = world(on, { tokens: 100, rows: () => conversation().rows })
    await start($)
    await complete($)
    await clock.advance(1000)
    expect(clones(seen)).toEqual([])
    expect(seen.resumes).toEqual([])
  })

  for (const status of ['pending', 'running', 'waiting'] as const) {
    test(`holds the queue while a subagent is ${status}, and forks once none is`, async ($, on) => {
      const w: World = { tokens: 100, rows: () => conversation().rows, agents: [{ id: 'sub', status }] }
      const { clock, seen } = world(on, w)
      await start($)
      await compress($, [{ startId: 'm0001', endId: 'm0003', summary: 'GOAL: did the thing' }])
      await complete($)
      await clock.advance(1000)
      expect(clones(seen)).toEqual([])
      w.agents = [{ id: 'sub', status: 'completed' }]
      await complete($)
      await clock.advance(1000)
      expect(clones(seen)).toHaveLength(1)
    })
  }

  test('forks while the only agents are idle or ended', async ($, on) => {
    const w: World = { tokens: 100, rows: () => conversation().rows, agents: ['idle', 'completed', 'failed', 'killed'].map((status, i) => ({ id: `a${i}`, status: status as any })) }
    const { clock, seen } = world(on, w)
    await start($)
    await compress($, [{ startId: 'm0001', endId: 'm0003', summary: 'GOAL: did the thing' }])
    await complete($)
    await clock.advance(1000)
    expect(clones(seen)).toHaveLength(1)
  })

  test('ignores turns that did not end in an answer and keeps the queue for the next one', async ($, on) => {
    const { clock, seen } = await queued($, on)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't', reason: 'aborted' })
    expect(clones(seen)).toEqual([])
    await complete($)
    await clock.advance(1000)
    expect(clones(seen)).toHaveLength(1)
  })

  test('a transcript that never reaches the final answer fails loudly and does not switch', async ($, on) => {
    const { clock, seen } = await queued($, on)
    const run = complete($, 'an answer the transcript lacks')
    await clock.advance(10_000)
    await run
    expect(seen.toasts[0]).toContain('lags the session')
    expect(seen.resumes).toEqual([])
    expect(clones(seen)).toEqual([])
  })
  test('a fork that cannot be written fails loudly and does not switch', async ($, on) => {
    const w: World = { tokens: 100, rows: () => conversation().rows }
    const { seen } = world(on, w)
    await start($)
    await compress($, [{ startId: 'm0001', endId: 'm0003', summary: 'GOAL: did the thing' }])
    w.writeExit = 1
    await complete($)
    expect(seen.toasts[0]).toContain('could not write the transcript')
    expect(seen.resumes).toEqual([])
  })
})

const tailHeavy = () => {
  const t = new Transcript()
  t.prompt('goal', 'm0001')
  t.call('Read', { file_path: '/a' }, { ref: 'm0002', output: 'AAA' })
  t.call('Bash', { command: 'ls' }, { ref: 'm0003', output: 'B'.repeat(8000) })
  t.text('all done')
  return t
}

describe('/dcp-prune', () => {
  const prune = async ($: any, args = '') => ($ as any).command.run({ command: 'dcp-prune', args })

  test('is registered with a hint argument', async ($, on) => {
    const { seen } = world(on, { tokens: 100, rows: () => conversation().rows })
    await start($)
    expect(seen.commands).toContain('dcp-prune')
  })

  test('asks the model to compress, with the hint, and says so', async ($, on) => {
    const { clock, seen } = world(on, { tokens: 100, rows: () => conversation().rows })
    await start($)
    expect((await prune($, ' the audit work ')).text).toBe('Asked the model to compress closed work.')
    await clock.advance(1000)
    expect(seen.prompts).toEqual([expect.stringContaining('one mcp__dcp__compress call')])
    expect(seen.prompts[0]).toContain('Focus: the audit work')
  })

  test('reports a refused submit loudly and drops the request', async ($, on) => {
    const { clock, seen } = world(on, { tokens: 99000, rows: () => conversation().rows, failing: 'prompt.submit' })
    await start($)
    await prune($)
    await clock.advance(1000)
    expect(seen.toasts.at(-1)).toContain('prompt.submit')
    expect((await compress($, [{ startId: 'm0001', endId: 'm0001', summary: 'x'.repeat(500) }])).deny).toContain('summaries must be stubs')
  })

  test('lets a full summary through under the min limit, which the stub rule would deny, and only until its turn ends', async ($, on) => {
    const { clock } = world(on, { tokens: 99000, rows: () => conversation().rows })
    await start($)
    await prune($)
    expect((await compress($, [{ startId: 'm0001', endId: 'm0001', summary: 'x'.repeat(500) }])).result).toContain('Compressed')
    await complete($)
    await clock.advance(1000)
    expect((await compress($, [{ startId: 'm0003', endId: 'm0003', summary: 'x'.repeat(500) }])).deny).toContain('summaries must be stubs')
  })

  test('forks although it would remove far less than it makes the cache rewrite, once', async ($, on) => {
    const t = tailHeavy()
    const { clock, seen } = world(on, { tokens: 100, rows: () => t.rows })
    await start($)
    await prune($)
    await compress($, [{ startId: 'm0002', endId: 'm0002', summary: 'read' }])
    await complete($)
    await clock.advance(1000)
    expect(clones(seen)).toHaveLength(1)
    expect(seen.writes[LOG]).not.toContain('fork waits')
    await compress($, [{ startId: 'm0002', endId: 'm0002', summary: 'read again' }])
    await complete($)
    await clock.advance(1000)
    expect(clones(seen)).toHaveLength(1)
    expect(seen.writes[LOG]).toContain('fork waits')
  })

  test('a prune that queued nothing does not make a later, smaller compress skip the check', async ($, on) => {
    const t = tailHeavy()
    const { clock, seen } = world(on, { tokens: 100, rows: () => t.rows })
    await start($)
    await prune($)
    await complete($)
    await compress($, [{ startId: 'm0002', endId: 'm0002', summary: 'read' }])
    await complete($)
    await clock.advance(1000)
    expect(clones(seen)).toEqual([])
  })
})

describe('classic.Stop', () => {
  const stop = ($: any, extra = {}) => $.classic.Stop({ stop_hook_active: false, ...extra })
  async function toolTurn($: any, on: On, tokens: number | undefined, store?: Record<string, unknown>) {
    const w = world(on, { tokens, rows: () => conversation().rows, store })
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/x' })
    return w
  }

  test('under the min limit, holds the stop back once with the drop prompt: stub summaries, no paraphrase', async ($, on) => {
    await toolTurn($, on, 30000)
    const { block } = await stop($)
    expect(block).toContain('DROP')
    expect(block).toContain('max 200 chars')
    expect(block).toContain('mcp__dcp__compress')
    expect(block).toContain('Largest uncompressed messages')
    expect(block).toContain('repeat your last answer verbatim')
    expect(block).not.toContain('VERY AGGRESSIVE')
  })

  test('from the min limit up, asks to compress and merge the largest chunks', async ($, on) => {
    await toolTurn($, on, 100000)
    const { block } = await stop($)
    expect(block).toContain('compress and merge')
    expect(block).not.toContain('max 200 chars')
  })

  test('above the max limit, asks to be very aggressive', async ($, on) => {
    await toolTurn($, on, 150001)
    expect((await stop($)).block).toContain('VERY AGGRESSIVE')
  })

  test('the max limit is raised by the tokens the active summaries hold', async ($, on) => {
    const t = conversation()
    t.block(1, 'S'.repeat(4000))
    world(on, { tokens: 151000, rows: () => t.rows })
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/x' })
    const { block } = await stop($)
    expect(block).toContain('compress and merge')
    expect(block).not.toContain('VERY AGGRESSIVE')
  })

  test('lets the stop through while the conversation has no two answered requests to size its messages by', async ($, on) => {
    const t = new Transcript()
    t.prompt('goal', 'm0001')
    t.call('Read', { file_path: '/a' }, { ref: 'm0002', output: 'AAA' })
    const { seen } = world(on, { tokens: 160000, rows: () => t.rows })
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/x' })
    expect((await stop($)).block).toBeUndefined()
    expect(seen.toasts).toEqual([])
  })

  test('lets the stop through while the engine still counts the old session: the last fork has not seen its first request', async ($, on) => {
    await toolTurn($, on, 160000, { 'stats2:old-id': recordFork(emptyStats(), { before: 1, estimated: 1, copied: 1, gone: [] }) })
    expect((await stop($)).block).toBeUndefined()
  })

  test('asks again on a later prompt although an earlier compression still waits in the queue', async ($, on) => {
    await toolTurn($, on, 160000)
    await compress($, [{ startId: 'm0001', endId: 'm0003', summary: 'dropped' }])
    expect((await stop($)).block).toBeUndefined()
    await submit($)
    await $.tool.call({ tool: 'Read', file_path: '/x' })
    expect((await stop($)).block).toContain('VERY AGGRESSIVE')
  })

  test('lets the stop through when the hook already held it back once', async ($, on) => {
    await toolTurn($, on, 160000)
    expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
  })

  test('lets the stop through when nothing was compressible: no tool result since the prompt, under the min limit', async ($, on) => {
    world(on, { tokens: 30000, rows: () => conversation().rows })
    await start($)
    await submit($)
    expect((await stop($)).block).toBeUndefined()
  })

  test('still asks without tool results when the context is over the min limit', async ($, on) => {
    world(on, { tokens: 100000, rows: () => conversation().rows })
    await start($)
    await submit($)
    expect((await stop($)).block).toContain('compress and merge')
  })

  test('lets the stop through when the model has already queued a compression this turn', async ($, on) => {
    await toolTurn($, on, 160000)
    await compress($, [{ startId: 'm0001', endId: 'm0003', summary: 'dropped' }])
    expect((await stop($)).block).toBeUndefined()
  })

  test('lets the stop through before any response gave a real token figure', async ($, on) => {
    await toolTurn($, on, undefined)
    expect((await stop($)).block).toBeUndefined()
  })

  test('reports a failure to read the transcript, and the stop goes through', async ($, on) => {
    const w: World = { tokens: 30000, rows: () => conversation().rows }
    const { seen } = world(on, w)
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/x' })
    w.readExit = 2
    expect((await stop($)).block).toBeUndefined()
    expect(seen.toasts.at(-1)).toContain('dcp: could not read the whole transcript')
  })
})

describe('ui.render ToolUse', () => {
  const render = ($: any, tool: string, input: unknown) =>
    $.ui.render({ surface: 'terminal', component: 'ToolUse', requestId: 'u1', props: { tool_use_id: 'u1', tool, input, isRunning: false, isErrored: false, isInterrupted: false } })

  test('folds each summary of a compress call to its head and size, keeping topic and ids', async ($, on) => {
    const { seen } = world(on, { rows: () => [] })
    await start($)
    await render($, TOOL, { topic: 'T', content: [{ startId: 'm0001', endId: 'm0003', summary: 'x'.repeat(500) }, { startId: 'm0004', endId: 'm0005', summary: 'short' }] })
    expect(seen.rendered[0].input).toEqual({
      topic: 'T',
      content: [{ startId: 'm0001', endId: 'm0003', summary: `${'x'.repeat(80)}… (500 chars)` }, { startId: 'm0004', endId: 'm0005', summary: 'short' }],
    })
  })

  test('leaves other tools, and a compress call still streaming without summaries, as they are', async ($, on) => {
    const { seen } = world(on, { rows: () => [] })
    await start($)
    await render($, 'Read', { content: [{ summary: 'y'.repeat(500) }] })
    await render($, TOOL, { topic: 'T' })
    expect(seen.rendered[0].input.content[0].summary).toHaveLength(500)
    expect(seen.rendered[1].input).toEqual({ topic: 'T' })
  })
})
