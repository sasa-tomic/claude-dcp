import { describe, expect, test } from 'claude-code/testing'

import { applyCompression, cronCarry, staleCopies, wrapCompressedSummary } from './apply'
import { type Plan } from './compress'
import { tagLine } from './ids'
import { indexRows, tagOf } from './model'
import type { Row } from './rows'
import { Transcript } from './rows.fixture'

const plan = (s: number, e: number, finalSummary: string, consumedBlockIds: number[] = []): Plan => ({
  index: 0,
  entry: { startId: 'x', endId: 'y', summary: finalSummary },
  s,
  e,
  messageCount: 0,
  finalSummary,
  consumedBlockIds,
  saves: [],
})
let n = 0
const ctx = { sessionId: 'NEW', newUuid: () => `new${++n}` }

describe('wrapCompressedSummary', () => {
  test('puts the header first and the block tag last', () => {
    expect(wrapCompressedSummary(3, '  body ')).toBe(`[Compressed conversation section]\nbody\n\n${tagLine('b3')}`)
    expect(wrapCompressedSummary(3, '')).toBe(`[Compressed conversation section]\n${tagLine('b3')}`)
  })
})

describe('applyCompression', () => {
  function session() {
    const t = new Transcript()
    t.prompt('keep', 'm0001') // 0 prompt u1, 1 tag u2
    t.prompt('old goal', 'm0002') // 2 prompt u3, 3 tag u4
    t.call('Read', { file_path: '/a' }, { ref: 'm0003', output: 'AAA' }) // 4 use u5, 5 result u6, 6 tag u7
    t.rows.splice(7, 0, { ...t.rows[0], uuid: 'meta', type: 'queue-operation', parentUuid: 'u7' }) // 7 meta row after the range
    t.prompt('after', 'm0004') // 8 prompt u8 (parent u7), 9 tag
    return t
  }
  const summaryOf = (rows: Row[]) => rows.find(r => String(r.message?.content).startsWith('[Compressed conversation section]'))!

  test('replaces the range with one tagged summary user row and keeps everything outside it', () => {
    const t = session()
    const out = applyCompression(t.rows, indexRows(t.rows), [plan(2, 6, 'SUMMARY')], ctx)
    expect(out.map(r => r.type)).toEqual(['user', 'attachment', 'user', 'queue-operation', 'user', 'attachment'])
    expect(out[0].message.content).toBe('keep')
    expect(out[2].message.content).toBe(wrapCompressedSummary(1, 'SUMMARY'))
    expect(out[4].message.content).toBe('after')
    expect(out.map(r => tagOf(r))).toEqual([null, 'm0001', null, null, null, 'm0004'])
    expect(out.every(r => r.sessionId === 'NEW')).toBe(true)
  })

  test('relinks parentUuid across the removed rows', () => {
    const t = session()
    const out = applyCompression(t.rows, indexRows(t.rows), [plan(2, 6, 'S')], ctx)
    const summary = summaryOf(out)
    expect(summary.parentUuid).toBe('u2')
    expect(out[3].parentUuid).toBe(summary.uuid) // the kept queue-operation pointed at the removed tag row
    expect(out[4].parentUuid).toBe(summary.uuid) // 'after' pointed at the removed tag row too
    const uuids = new Set(out.map(r => r.uuid))
    expect(out.every(r => r.parentUuid === null || uuids.has(r.parentUuid))).toBe(true)
  })

  test('removes tool calls with their results and the removed prompts\' tag rows together, leaving no orphan', () => {
    const t = session()
    const out = applyCompression(t.rows, indexRows(t.rows), [plan(2, 6, 'S')], ctx)
    const blocks = out.flatMap(r => (Array.isArray(r.message?.content) ? r.message.content : []))
    expect(blocks.filter(b => b.type === 'tool_use' || b.type === 'tool_result')).toEqual([])
    expect(out.flatMap(r => tagOf(r) ?? [])).toEqual(['m0001', 'm0004'])
  })

  test('also removes the stale token-count reminders and task notifications inside the range, and keeps other system attachments and reminders outside it', () => {
    const t = session()
    const reminder = (uuid: string) => ({ ...t.rows[0], uuid, type: 'attachment', attachment: { type: 'total_tokens_reminder', content: 'x' } })
    const skills = { ...t.rows[0], uuid: 'skills', type: 'attachment', attachment: { type: 'skill_listing', content: 'big listing' } }
    const notice = { ...t.rows[0], uuid: 'n-in', type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>done</task-notification>' } }
    t.rows.splice(5, 0, reminder('r-in'), skills, notice) // inside the range: between the assistant call and its result
    t.rows.push(reminder('r-after'))
    const idx = indexRows(t.rows)
    const [s, e] = [2, idx.units.get('m0003')!.end]
    const out = applyCompression(t.rows, idx, [plan(s, e, 'S')], ctx)
    const kept = out.flatMap(r => (r.type === 'attachment' ? [r.attachment.type + ':' + r.uuid] : []))
    expect(kept).toContain('skill_listing:skills')
    expect(kept).toContain('total_tokens_reminder:r-after')
    expect(kept).not.toContain('total_tokens_reminder:r-in')
    expect(kept).not.toContain('queued_command:n-in')
  })

  test('allocates block ids after the highest existing one, in range order, and drops consumed block rows', () => {
    const t = new Transcript()
    t.block(4, 'old block') // 0
    t.prompt('a', 'm0001') // 1 prompt, 2 tag
    t.prompt('b', 'm0002') // 3 prompt, 4 tag
    t.prompt('c', 'm0003') // 5 prompt, 6 tag
    const out = applyCompression(t.rows, indexRows(t.rows), [plan(0, 2, 'first', [4]), plan(5, 6, 'second')], ctx)
    expect(out.filter(r => r.message).map(r => r.message.content)).toEqual([wrapCompressedSummary(5, 'first'), 'b', wrapCompressedSummary(6, 'second')])
    expect(JSON.stringify(out)).not.toContain('old block')
  })

  test('does not mutate its input and keeps timestamps and user metadata of the first removed row', () => {
    const t = session()
    t.rows[2].userType = 'external'
    t.rows[2].cwd = '/w'
    t.rows[2].timestamp = 'T1'
    const before = JSON.stringify(t.rows)
    const out = applyCompression(t.rows, indexRows(t.rows), [plan(2, 6, 'S')], ctx)
    expect(JSON.stringify(t.rows)).toBe(before)
    expect(summaryOf(out)).toMatchObject({ type: 'user', isSidechain: false, userType: 'external', cwd: '/w', timestamp: 'T1' })
  })
  test('drops memory copies a newer copy of the same path supersedes, wherever they are, and relinks past them', () => {
    const t = session()
    const memory = (uuid: string, path: string, parentUuid: string) => ({ ...t.rows[0], uuid, parentUuid, type: 'attachment', attachment: { type: 'nested_memory', path }, rendered: [{ content: `Contents of ${path}` }] })
    t.rows.splice(1, 0, memory('old', '/a/CLAUDE.md', 'u1'), memory('other', '/b/CLAUDE.md', 'old'))
    t.rows[3].parentUuid = 'other'
    t.rows.push(memory('new', '/a/CLAUDE.md', t.rows.at(-1)!.uuid))
    expect(staleCopies(t.rows)).toEqual([1])
    const out = applyCompression(t.rows, indexRows(t.rows), [], ctx)
    expect(out.map(r => r.uuid)).not.toContain('old')
    expect(out.find(r => r.uuid === 'other')!.parentUuid).toBe('u1')
    expect(out.filter(r => r.attachment?.type === 'nested_memory').map(r => r.uuid)).toEqual(['other', 'new'])
  })
  test('drops all but the newest of identical attachments; differing bodies, queued commands and id tags stay', () => {
    const t = session()
    const att = (uuid: string, attachment: Record<string, any>, body: string) => ({ ...t.rows[0], uuid, type: 'attachment', attachment, rendered: [{ content: body }] })
    const rows = [
      att('skills1', { type: 'skill_listing' }, 'skills'),
      att('env1', { type: 'environment' }, 'cwd /a'),
      att('q1', { type: 'queued_command', prompt: 'tick' }, 'tick'),
      att('tag1', { type: 'hook_additional_context', hookName: 'prompt.submit', content: ['<dcp-message-id>m0009</dcp-message-id>'] }, 'same'),
      att('skills2', { type: 'skill_listing' }, 'skills'),
      att('env2', { type: 'environment' }, 'cwd /b'),
      att('q2', { type: 'queued_command', prompt: 'tick' }, 'tick'),
      att('tag2', { type: 'hook_additional_context', hookName: 'prompt.submit', content: ['<dcp-message-id>m0010</dcp-message-id>'] }, 'same'),
    ]
    t.rows.push(...rows.map((r, i) => ({ ...r, parentUuid: i === 0 ? t.rows.at(-1)!.uuid : rows[i - 1].uuid })))
    const out = applyCompression(t.rows, indexRows(t.rows), [], ctx)
    expect(out.filter(r => rows.some(a => a.uuid === r.uuid)).map(r => r.uuid)).toEqual(['env1', 'q1', 'tag1', 'skills2', 'env2', 'q2', 'tag2'])
    expect(out.find(r => r.uuid === 'env1')!.parentUuid).toBe(t.rows.find(r => r.uuid === 'skills1')!.parentUuid)
  })
})

describe('cronCarry', () => {
  // 0 prompt, 1 tag, 2..4 CronCreate a (session-only), 5..7 CronCreate d (durable), 8..10 CronCreate b, 11..13 CronDelete b, 14 prompt, 15 tag
  function session() {
    const t = new Transcript()
    t.prompt('schedule', 'm0001')
    t.call('CronCreate', { cron: '7 3 1 1 *', prompt: 'ping' }, { ref: 'm0002', result: { id: 'a', recurring: false } })
    t.call('CronCreate', { cron: '8 3 1 1 *', prompt: 'disk' }, { ref: 'm0003', result: { id: 'd', recurring: true, durable: true } })
    t.call('CronCreate', { cron: '*/5 * * * *', prompt: 'poll' }, { ref: 'm0004', result: { id: 'b', recurring: true } })
    t.call('CronDelete', { id: 'b' }, { ref: 'm0005', result: { id: 'b' } })
    t.prompt('later', 'm0006')
    t.rows.forEach((r, i) => (r.timestamp = new Date(Date.UTC(2026, 9, 29, 20, i)).toISOString()))
    return t
  }
  const note = (tasks: unknown[], ended: string[] = []) => ({ type: 'attachment', uuid: 'note', attachment: { type: 'session_cron_carry', tasks, ended } })

  test('carries the session-only crons the removed calls made, less deleted and durable ones, after the previous note\'s tasks', () => {
    const t = session()
    const old = { id: 'o', cron: '1 1 1 1 *', prompt: 'old', createdAt: 1, recurring: false }
    t.rows.splice(0, 0, { ...note([old, { id: 'x', cron: '2 2 2 2 *', prompt: 'gone', createdAt: 2, recurring: false }], ['x']), parentUuid: null })
    t.rows[1].parentUuid = 'note'
    const out = applyCompression(t.rows, indexRows(t.rows), [plan(1, 14, 'S')], ctx)
    const notes = out.filter(r => r.attachment?.type === 'session_cron_carry')
    expect(notes.map(r => r.uuid)).toEqual([out[1].uuid]) // right after the summary, which the next prompt now hangs from via the note
    expect(out[1]).toMatchObject({ parentUuid: out[0].uuid, sessionId: 'NEW', timestamp: out[0].timestamp })
    expect(out[2].parentUuid).toBe(out[1].uuid)
    expect(out[1].attachment).toEqual({ type: 'session_cron_carry', tasks: [old, { id: 'a', cron: '7 3 1 1 *', prompt: 'ping', createdAt: Date.parse(t.rows[3].timestamp), recurring: false }], ended: ['x', 'b'] })
    expect(out[0].parentUuid).toBe(null) // the summary's parent was the replaced note
  })

  test('writes no note when no cron call is removed, and fails loudly on a CronCreate result without a job id', () => {
    const t = session()
    expect(cronCarry(t.rows, indexRows(t.rows), new Set([0, 14]))).toBeNull()
    expect(applyCompression(t.rows, indexRows(t.rows), [], ctx).some(r => r.attachment?.type === 'session_cron_carry')).toBe(false)
    t.rows[3].toolUseResult = {}
    expect(() => cronCarry(t.rows, indexRows(t.rows), new Set([2]))).toThrow('CronCreate toolu_3 at row 2 has no job id or timestamp to carry: {}')
  })
})
