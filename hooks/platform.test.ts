import { describe, expect, test } from 'claude-code/testing'

import { ARCHIVE, HOME, ID, OLD, OLDER, PROJECT, compress, complete, conversation, start, world } from './world.fixture'

const archive = ($: any) => $.command.run({ command: 'dcp-archive', args: '' })
const WINDOWS = { OS: 'Windows_NT', USERPROFILE: HOME, HOME: '/c/Users/u', SystemRoot: 'C:\\Windows' }

describe('on Windows', () => {
  async function fork($: any, on: any, extra = {}) {
    const w = world(on, { tokens: 100, rows: () => conversation().rows, session: { id: ID, switchOnResume: true }, env: WINDOWS, saved: true, ...extra })
    await start($)
    await compress($, [{ startId: 'm0001', endId: 'm0003', summary: 'GOAL: did the thing' }])
    await complete($)
    await w.clock.advance(1000)

    return w
  }

  test('forks and archives through PowerShell scripts that take every path from the environment, none quoted in', async ($, on) => {
    const { seen, files } = await fork($, on)
    expect(seen.toasts.at(-1)).toContain('dcp: compressed 1 range(s)')
    expect(files.has(`${ARCHIVE}/${ID}.jsonl`)).toBe(true)
    expect(seen.shell).toContainEqual(['find', `${PROJECT}/dcp-outputs`, '-type', 'f', '-mmin', '+14400', '-delete'])
    for (const script of seen.scripts) expect(script).not.toContain(HOME)
  })

  test('names the failed PowerShell command and its values', async ($, on) => {
    const { seen } = await fork($, on, { failing: 'mv' })
    expect(seen.toasts.at(-1)).toContain(`dcp: powershell move ${PROJECT}/${ID}.jsonl ${ARCHIVE} failed: exit 1, denied`)
  })

  test('lists archived sessions with the titles PowerShell finds, untitled when it finds none', async ($, on) => {
    world(on, { rows: () => conversation().rows, env: WINDOWS, archived: { [OLD]: { ageDays: 3, title: 'Fix the parser' }, [OLDER]: { ageDays: 9 } } })
    const text = (await archive($)).text
    expect(text).toContain(`${OLD} · Fix the parser · 3d ago`)
    expect(text).toContain(`${OLDER} · untitled · 9d ago`)
  })

  test('reports loudly when SystemRoot is unset, so PowerShell cannot be found', async ($, on) => {
    world(on, { rows: () => conversation().rows, env: { ...WINDOWS, SystemRoot: '' }, archived: { [OLD]: { ageDays: 3 } } })
    expect((await archive($)).text).toBe('dcp: cannot find PowerShell: SystemRoot is unset')
  })
})
