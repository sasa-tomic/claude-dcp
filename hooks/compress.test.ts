import { describe, expect, test } from 'claude-code/testing'

import { COMPRESS_REPLY, type CompressConfig, type Entry, KEPT_HEADER, KEPT_USER_LIMIT, keptUserCount, mergeQueue, planCompression } from './compress'
import { indexRows } from './model'
import { Transcript } from './rows.fixture'
import { PRUNED_COMPRESS_SUMMARY } from './strategies'

const cfg: CompressConfig = { protectedTools: ['Task'], protectedFilePatterns: ['**/*.env'] }
const range = (startId: string, endId: string, summary = 'S') => ({ startId, endId, summary })
const OUT = '/p/dcp-outputs'
const plan = (t: Transcript, content: Entry[], config = cfg) => planCompression(t.rows, indexRows(t.rows), { topic: 'T', content }, config, OUT)

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
    expect(() => planCompression(t.rows, idx, { topic: ' ', content: [range('m0001', 'm0002')] }, cfg, OUT)).toThrow('topic must be a non-empty string')
    expect(() => planCompression(t.rows, idx, { topic: 'T', content: [] }, cfg, OUT)).toThrow('content must be a non-empty array')
    expect(() => plan(t, [range('m0001', 'm0002', '  ')])).toThrow('content[0].summary must be a non-empty string')
    expect(() => plan(t, [{ ...range('m0001', 'm0002'), drop: 'm0001' as never }])).toThrow('content[0].drop must be an array of user-message IDs')
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

  test('widens the range over the companion row Claude Code writes between an image result and its id tag, and does not count that row as a message', () => {
    const t = new Transcript()
    t.prompt('go', 'm0001') // 0-1
    t.rows.push({ ...t.rows[0], uuid: 'ua', type: 'assistant', message: { id: 'A', role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: {} }, { type: 'tool_use', id: 'c2', name: 'Read', input: {} }] } }) // 2
    const tag = (id: string, ref: string) => ({ ...t.rows[0], uuid: `t${id}`, type: 'attachment', attachment: { type: 'hook_additional_context', content: [`<dcp-message-id>${ref}</dcp-message-id>`], hookName: 'tool.call', toolUseID: `${id}-context` } })
    const result = (id: string) => ({ ...t.rows[0], uuid: `r${id}`, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] } })
    const companion = (id: string) => ({ ...t.rows[0], uuid: `k${id}`, type: 'user', isMeta: true, turnCompanion: true, message: { role: 'user', content: '[Image: original 20x10]' } })
    t.rows.push(result('c1'), companion('c1'), tag('c1', 'm0002'), result('c2'), companion('c2'), tag('c2', 'm0003')) // 3-8
    const [p] = plan(t, [range('m0002', 'm0002')])
    expect([p.s, p.e, p.messageCount]).toEqual([2, 8, 1])
  })
})

describe('kept verbatim', () => {
  const kept = (summary: string) => summary.slice(summary.indexOf(KEPT_HEADER))

  test('keeps what the user typed, prompts and messages queued during a turn, and nothing other prompts carry', () => {
    const t = new Transcript()
    t.prompt('build X', 'm0001', 'human')
    t.prompt('Stop hook feedback: compress', 'm0002')
    t.queued('also Y', 'human', 'm0003')
    t.queued('<agent-message>report</agent-message>', 'peer')
    t.call('Bash', { command: 'ls' }, { ref: 'm0004', output: 'BBB' })
    const [p] = plan(t, [range('m0001', 'm0004', 'dense')])
    expect(p.finalSummary).toBe(`dense\n\n${KEPT_HEADER}\n### User message m0001\nbuild X\n\n### User message m0003\nalso Y`)
  })

  test('keeps outputs of protected tools and of calls touching protected files, in conversation order', () => {
    const t = new Transcript()
    t.prompt('go', 'm0001')
    t.call('Task', { description: 'x' }, { ref: 'm0002', output: 'AGENT REPORT' })
    t.call('Read', { file_path: '/p/.env' }, { ref: 'm0003', output: 'SECRET=1' })
    t.call('Read', { file_path: '/p/a.ts' }, { ref: 'm0004', output: 'plain' })
    expect(kept(plan(t, [range('m0001', 'm0004')])[0].finalSummary)).toBe(`${KEPT_HEADER}\n### Tool: Task\nAGENT REPORT\n\n### Tool: Read\nSECRET=1`)
  })

  test("drops a protected tool's background-launch notice, in new ranges and in the kept parts of merged blocks", () => {
    const launch = 'Async agent launched successfully.\nagentId: a1\n\nDo not duplicate this agent.'
    const t = new Transcript()
    t.block(1, `old\n\n${KEPT_HEADER}\n### User message m0001\nfirst\n\n### Tool: Agent\n${launch}\n\n### Tool: Agent\nREPORT`)
    t.prompt('go', 'm0002')
    t.call('Agent', { description: 'x' }, { ref: 'm0003', output: launch, result: { status: 'async_launched' } })
    expect(kept(plan(t, [range('b1', 'm0003')])[0].finalSummary)).toBe(`${KEPT_HEADER}\n### User message m0001\nfirst\n\n### Tool: Agent\nREPORT`)
  })

  test('a summary alone when nothing is kept', () => {
    expect(plan(session(), [range('m0002', 'm0003')])[0].finalSummary).toBe('S')
  })

  test("keeps the model's last messages, one item per message, and not Claude Code's placeholder answers", () => {
    const t = new Transcript()
    t.prompt('go', 'm0001', 'human')
    for (let i = 1; i <= 11; i++) t.call('Bash', { command: `c${i}` }, { ref: `m${String(i + 1).padStart(4, '0')}`, output: 'o' }), t.text(`note ${i}`)
    t.text(' and more', `msg${t.rows.length}`) // a second row of the last message
    t.rows.push({ ...t.rows.at(-1)!, uuid: 'syn', type: 'assistant', message: { id: 'syn', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] } })
    t.call('Read', { file_path: '/a' }, { ref: 'm0013' })
    const items = kept(plan(t, [range('m0001', 'm0013')])[0].finalSummary).split('\n\n')
    expect(items).toEqual([`${KEPT_HEADER}\n### User message m0001\ngo`, ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => `### AI message\nnote ${i}`), '### AI message\nnote 11 and more'])
  })

  test("does not keep the one-word reply after a compress call, nor count it among the model's last messages", () => {
    const t = new Transcript()
    t.prompt('go', 'm0001', 'human')
    for (let i = 1; i <= 10; i++) t.call('Bash', { command: `c${i}` }, { ref: `m${String(i + 1).padStart(4, '0')}`, output: 'o' }), t.text(`note ${i}`)
    t.text(COMPRESS_REPLY)
    t.call('Read', { file_path: '/a' }, { ref: 'm0012' })
    const items = kept(plan(t, [range('m0001', 'm0012')])[0].finalSummary).split('\n\n')
    expect(items).toEqual([`${KEPT_HEADER}\n### User message m0001\ngo`, ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => `### AI message\nnote ${i}`)])
  })

  test('keeps the answers of the last two turns however many messages came after them, and drops older answers', () => {
    const t = new Transcript()
    for (const turn of [1, 2, 3]) {
      t.prompt(`ask ${turn}`, `m000${turn}`, 'human')
      t.text(`answer ${turn}`)
    }
    for (let i = 0; i < 10; i++) t.text(`late ${i}`)
    t.call('Read', { file_path: '/a' }, { ref: 'm0004' })
    expect(kept(plan(t, [range('m0001', 'm0003')])[0].finalSummary)).toBe(
      `${KEPT_HEADER}\n### User message m0001\nask 1\n\n### User message m0002\nask 2\n\n### AI message\nanswer 2\n\n### User message m0003\nask 3`,
    )
  })

  test("a merged block drops the model messages it kept that are no longer recent, and keeps its other items", () => {
    const t = new Transcript()
    t.block(1, `old\n\n${KEPT_HEADER}\n### User message m0001\nfirst\n\n### AI message\nstale\n\n### Tool: Task\nREPORT`)
    t.prompt('second', 'm0002', 'human')
    t.text('answer 2')
    t.prompt('third', 'm0003', 'human')
    for (let i = 0; i < 10; i++) t.text(`new ${i}`)
    t.call('Read', { file_path: '/a' }, { ref: 'm0004' })
    expect(kept(plan(t, [range('b1', 'm0003')])[0].finalSummary)).toBe(
      `${KEPT_HEADER}\n### User message m0001\nfirst\n\n### Tool: Task\nREPORT\n\n### User message m0002\nsecond\n\n### AI message\nanswer 2\n\n### User message m0003\nthird`,
    )
  })

  test('escapes a line inside a kept message that reads as an item head, so a later merge keeps the message whole', () => {
    const t = new Transcript()
    t.prompt('see:\n\n### AI message\nfake', 'm0001', 'human')
    for (let i = 0; i < 10; i++) t.text(`new ${i}`)
    t.call('Read', { file_path: '/a' }, { ref: 'm0002' })
    const first = kept(plan(t, [range('m0001', 'm0001')])[0].finalSummary)
    expect(first).toBe(`${KEPT_HEADER}\n### User message m0001\nsee:\n\n\\### AI message\nfake`)
    const merged = new Transcript()
    merged.block(1, `old\n\n${first}`)
    for (let i = 0; i < 10; i++) merged.text(`new ${i}`)
    merged.call('Read', { file_path: '/a' }, { ref: 'm0002' })
    expect(kept(plan(merged, [range('b1', 'b1')])[0].finalSummary)).toBe(first)
  })

  test('a block inside the range gives up its summary and passes on its kept part; one without a kept part passes nothing', () => {
    const t = new Transcript()
    t.block(1, `old summary\n\n${KEPT_HEADER}\n### User message m0001\nfirst`)
    t.block(2, 'legacy summary')
    t.prompt('second', 'm0002', 'human')
    const [p] = plan(t, [range('b1', 'm0002', 'merged')])
    expect(p.finalSummary).toBe(`merged\n\n${KEPT_HEADER}\n### User message m0001\nfirst\n\n### User message m0002\nsecond`)
    expect(p.consumedBlockIds).toEqual([1, 2])
  })

  test('refuses a summary that contains the kept header', () => {
    expect(() => plan(session(), [range('m0001', 'm0002', `x\n${KEPT_HEADER}\ny`)])).toThrow(`content[0].summary must not contain ${KEPT_HEADER}`)
  })

  test('refuses a summary citing a block the range replaces, whose text would be gone; others may be cited', () => {
    const t = session()
    t.block(1, 'old')
    t.block(2, 'other')
    expect(() => plan(t, [range('b1', 'b1', 'see (b1)\n(b2)')])).toThrow('content[0].summary cites (b1), which this range replaces')
    expect(plan(t, [range('b1', 'b1', 'see (b2)')])[0].finalSummary).toBe('see (b2)')
  })

  test('refuses the pruned-call marker as a summary: it would empty the block', () => {
    expect(() => plan(session(), [range('m0001', 'm0002', PRUNED_COMPRESS_SUMMARY)])).toThrow(`content[0].summary must not contain ${PRUNED_COMPRESS_SUMMARY}`)
  })
})

describe('dropped user messages', () => {
  const ref = (n: number) => `m${String(n).padStart(4, '0')}`
  /** A block keeping `count` user messages m0001.., then one typed prompt and a tool call after it. */
  function crowded(count: number) {
    const t = new Transcript()
    t.block(1, `old\n\n${KEPT_HEADER}\n${Array.from({ length: count }, (_, i) => `### User message ${ref(i + 1)}\nask ${i + 1}`).join('\n\n')}`)
    t.prompt('latest', ref(count + 1), 'human')
    t.call('Read', { file_path: '/a' }, { ref: ref(count + 2) })
    return t
  }

  test('past the limit, drops the named user messages of the range and keeps the others verbatim', () => {
    const t = crowded(KEPT_USER_LIMIT)
    expect(keptUserCount(t.rows, indexRows(t.rows))).toBe(KEPT_USER_LIMIT + 1)
    const [p] = plan(t, [{ ...range('b1', ref(KEPT_USER_LIMIT + 1)), drop: ['m0002', ` ${ref(KEPT_USER_LIMIT + 1).toUpperCase()} `] }])
    const users = p.finalSummary.match(/^### User message m\d+$/gm)!
    expect(users).toHaveLength(KEPT_USER_LIMIT - 1)
    expect(users).not.toContain('### User message m0002')
    expect(p.finalSummary).toContain('### User message m0003\nask 3')
    expect(p.finalSummary).not.toContain('latest')
  })

  test('up to the limit, refuses any drop', () => {
    const t = crowded(KEPT_USER_LIMIT - 1)
    expect(() => plan(t, [{ ...range('b1', ref(KEPT_USER_LIMIT)), drop: ['m0002'] }])).toThrow(
      `content[0].drop: the conversation keeps ${KEPT_USER_LIMIT} user messages; up to ${KEPT_USER_LIMIT} all stay verbatim, so drop none`,
    )
  })

  test('refuses ids that are not user messages kept inside the range', () => {
    const t = crowded(KEPT_USER_LIMIT)
    const tool = ref(KEPT_USER_LIMIT + 2)
    expect(() => plan(t, [{ ...range('b1', 'b1'), drop: [ref(KEPT_USER_LIMIT + 1), tool] }])).toThrow(`content[0].drop: ${ref(KEPT_USER_LIMIT + 1)}, ${tool} are not user messages kept inside b1..b1`)
  })

  test('fails loudly on a kept or typed user message without an id, which could never be dropped', () => {
    const old = new Transcript()
    old.block(1, `old\n\n${KEPT_HEADER}\n### User message\nfirst`)
    old.prompt('go', 'm0001')
    expect(() => plan(old, [range('b1', 'm0001')])).toThrow('the kept user message of the block at row 0 has no message id: "### User message\\nfirst"')
    const untagged = new Transcript()
    untagged.prompt('go', 'm0001')
    untagged.queued('also', 'human')
    untagged.call('Read', { file_path: '/a' }, { ref: 'm0002' })
    expect(() => plan(untagged, [range('m0001', 'm0002')])).toThrow('the message the user typed at row 2 has no message id: "also"')
  })
})

describe('saved outputs', () => {
  test('saves a named output to a file and keeps its path in place of the text', () => {
    const [p] = plan(session(), [{ ...range('m0001', 'm0003'), save: ['M0003'] }])
    expect(p.saves).toEqual([{ path: `${OUT}/toolu_6.txt`, text: 'BBB' }])
    expect(p.finalSummary).toBe(`S\n\n${KEPT_HEADER}\n### Saved output: Bash ls\n${OUT}/toolu_6.txt`)
  })

  test('refuses ids that are not a successful, unprotected tool output inside the range', () => {
    const t = session()
    t.call('Task', {}, { ref: 'm0006', output: 'R' })
    t.call('Bash', {}, { ref: 'm0007', isError: true })
    const refused = (save: string[], end = 'm0007') => () => plan(t, [{ ...range('m0001', end), save }])
    for (const id of ['m0001', 'm0006', 'm0007', 'zz']) expect(refused([id])).toThrow(`content[0].save: ${id} is not the ID of a successful, unprotected tool output inside m0001..m0007`)
    expect(refused(['m0005'], 'm0003')).toThrow('m0005 is not the ID')
    expect(refused('m0002' as any)).toThrow('content[0].save must be an array of tool-output IDs')
  })
})

describe('mergeQueue', () => {
  const q = (startId: string, endId: string, s: number, e: number, index = 0) => ({ index, entry: range(startId, endId), s, e })
  const queued = [q('m0010', 'm0020', 10, 20)]

  test('adds a range disjoint from the queued ones', () => {
    const { queue, notes } = mergeQueue(queued, [q('m0021', 'm0030', 21, 30)])
    expect(queue.map(r => r.entry.startId)).toEqual(['m0010', 'm0021'])
    expect(notes).toEqual([])
  })

  test('skips a range inside a queued one, saying where it already is', () => {
    const { queue, notes } = mergeQueue(queued, [q('m0012', 'm0018', 12, 18)])
    expect(queue).toEqual(queued)
    expect(notes).toEqual(['m0012..m0018 skipped: it lies inside m0010..m0020, already queued'])
  })

  test('replaces the queued ranges a new range covers', () => {
    const { queue, notes } = mergeQueue([...queued, q('m0025', 'm0026', 25, 26)], [q('m0005', 'm0030', 5, 30)])
    expect(queue.map(r => [r.s, r.e])).toEqual([[5, 30]])
    expect(notes).toEqual(['m0005..m0030 replaces m0010..m0020, queued earlier', 'm0005..m0030 replaces m0025..m0026, queued earlier'])
  })

  test('replaces a queued range given again with a new summary', () => {
    const { queue, notes } = mergeQueue(queued, [q('m0010', 'm0020', 10, 20)])
    expect(queue).toEqual([q('m0010', 'm0020', 10, 20)].map(({ entry, s, e }) => ({ entry, s, e })))
    expect(notes).toEqual(['m0010..m0020 replaces m0010..m0020, queued earlier'])
  })

  test('refuses a partial overlap, naming the queued range apart from this call\'s entries', () => {
    expect(() => mergeQueue(queued, [q('m0021', 'm0022', 21, 22), q('m0015', 'm0025', 15, 25, 1)])).toThrow(
      'content[1] (m0015..m0025) partly overlaps m0010..m0020, queued by an earlier call and not applied yet. Cover all of m0010..m0020 to replace it, or none of it.',
    )
  })
})
