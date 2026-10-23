import { describe, expect, test } from 'claude-code/testing'

import { ARCHIVE, DAY, HOME, ID, OLD, OLDER, PROJECT, SRC, STATUS, compress, complete, conversation, start, world } from './world.fixture'

const GOOD_ID = '33333333-3333-4333-8333-333333333333'

describe('archiving after a fork', () => {
  async function fork($: any, on: any, extra = {}) {
    const w = world(on, { tokens: 100, rows: () => conversation().rows, session: { id: ID, switchOnResume: true }, archived: { [OLDER]: { ageDays: 11 }, [OLD]: { ageDays: 3 } }, ...extra })
    await start($)
    await compress($, [{ startId: 'm0001', endId: 'm0003', summary: 'GOAL: did the thing' }])
    await complete($)
    await w.clock.advance(1000)

    return w
  }

  test('moves the old session into archive/ once the switch happened and deletes archived ones past the limit', async ($, on) => {
    const { seen, files } = await fork($, on)
    expect(seen.shell).toEqual([
      ['mkdir', '-p', ARCHIVE],
      ['mv', SRC, `${ARCHIVE}/`],
      ['rm', '-rf', '--', `${ARCHIVE}/${OLDER}.jsonl`, `${ARCHIVE}/${OLDER}`, `${HOME}/.claude/dcp-status-${OLDER}`],
      ['rm', '-f', '--', STATUS],
    ])
    expect(files.has(SRC)).toBe(false)
    expect(files.has(`${ARCHIVE}/${ID}.jsonl`)).toBe(true)
    expect(files.has(`${ARCHIVE}/${OLD}.jsonl`)).toBe(true)
    expect(files.has(`${ARCHIVE}/${OLDER}.jsonl`)).toBe(false)
  })

  test('leaves the old session where it is when the switch did not happen', async ($, on) => {
    const { seen, files } = await fork($, on, { session: { id: ID } })
    expect(seen.shell).toEqual([])
    expect(files.has(SRC)).toBe(true)
    expect(seen.toasts.at(-1)).toContain('did not happen')
  })

  test('reports a failed move after the switch instead of ignoring it', async ($, on) => {
    const { seen } = await fork($, on, { failing: 'mv' })
    expect(seen.toasts.at(-1)).toContain(`dcp: mv ${SRC} ${ARCHIVE}/ failed: exit 1, denied`)
  })
})

describe('/dcp-archive and /dcp-restore', () => {
  const run = ($: any, command: string, args = '') => $.command.run({ command, args })

  test('register at session start', async ($, on) => {
    const { seen } = world(on, { rows: () => conversation().rows })
    await start($)
    expect(seen.commands).toEqual(['dcp-archive', 'dcp-restore', 'dcp-prune', 'dcp-stats'])
  })

  test('list archived sessions, newest first, with title, age and size', async ($, on) => {
    world(on, { rows: () => conversation().rows, archived: { [OLD]: { ageDays: 3, size: 2_500_000, title: 'Fix the parser' }, [OLDER]: { ageDays: 9, size: 400_000 } } })
    expect((await run($, 'dcp-archive')).text).toBe(`${OLD} · Fix the parser · 3d ago · 2.5 MB\n${OLDER} · untitled · 9d ago · 0.4 MB\n\nRestore one with /dcp-restore <id>, then /resume.`)
  })

  test('say so when nothing is archived', async ($, on) => {
    world(on, { rows: () => conversation().rows })
    expect((await run($, 'dcp-archive')).text).toBe('No archived sessions.')
  })

  test('restore moves an archived session back into the project', async ($, on) => {
    const { seen, files } = world(on, { rows: () => conversation().rows, archived: { [OLD]: { ageDays: 3 } } })
    expect((await run($, 'dcp-restore', ` ${OLD} `)).text).toBe(`Restored ${OLD}. Open it with /resume.`)
    expect(seen.shell).toEqual([['mv', `${ARCHIVE}/${OLD}.jsonl`, `${PROJECT}/`]])
    expect(files.has(`${PROJECT}/${OLD}.jsonl`)).toBe(true)
  })

  test('restore answers an error for what is not an archived session id', async ($, on) => {
    world(on, { rows: () => conversation().rows, archived: { [OLD]: { ageDays: 3 } } })
    expect((await run($, 'dcp-restore', '../x')).text).toBe('dcp: "../x" is not a session id; list them with /dcp-archive')
    expect((await run($, 'dcp-restore', GOOD_ID)).text).toBe(`dcp: no archived session ${GOOD_ID}; list them with /dcp-archive`)
  })
})
