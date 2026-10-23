import { expect, mock } from 'claude-code/testing'
import type { AgentStatus, On } from 'claude-code'

import { indexRows } from './model'
import { Transcript } from './rows.fixture'
import { parseTranscript, serializeTranscript } from './transcript'

export const HOME = '/home/u'
export const CWD = '/somewhere/else/entirely' // the session's cwd moves with every `cd`; the transcript does not
export const ID = 'old-id'
export const PROJECTS = `${HOME}/.claude/projects`
export const SRC = `${PROJECTS}/-work-proj/${ID}.jsonl`
export const TOOL = 'mcp__dcp__compress'
export const PROJECT = `${PROJECTS}/-work-proj`
export const ARCHIVE = `${PROJECT}/archive`
export const OLD = '00000000-0000-4000-8000-000000000001'
export const OLDER = '00000000-0000-4000-8000-000000000002'
export const DAY = 86_400_000
export const LOG = `${HOME}/.claude/dcp.log`
export const STATUS = `${HOME}/.claude/dcp-status-${ID}`

export type World = { tokens?: number; appended?: unknown[]; rows: () => unknown[]; exists?: boolean; store?: Record<string, unknown>; session?: { id: string; switchOnResume?: boolean }; readExit?: number; writeExit?: number; draft?: string; fillRefusal?: 'dialog'; archived?: Record<string, { ageDays: number; size?: number; title?: string }>; failing?: string; agents?: { id: string; status: AgentStatus }[] }

export function world(on: On, w: World) {
  const clock = mock.clock(on)
  mock.store(on, w.store)
  mock.env(on, { HOME })
  const seen = { writes: {} as Record<string, string>, toasts: [] as string[], statuses: [] as (string | undefined)[], resumes: [] as string[], tools: [] as any[], rendered: [] as any[], fills: [] as string[], shell: [] as string[][], commands: [] as string[] }
  // the project folder as a path -> file model, mutated by mkdir, mv and rm; the session's own transcript starts in it
  const files = new Map<string, { size: number; ageDays: number; title?: string }>([[SRC, { size: 1, ageDays: 0 }]])
  for (const [id, meta] of Object.entries(w.archived ?? {})) files.set(`${ARCHIVE}/${id}.jsonl`, { size: meta.size ?? 1, ageDays: meta.ageDays, title: meta.title })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('classic.Stop', () => ({}))
  on('prompt.read', () => ({ value: { text: w.draft ?? '', cursor: 0 } }))
  on('prompt.fill', (_$, e) => {
    seen.fills.push(e.text)
    return w.fillRefusal ? { isFilled: false, refusal: w.fillRefusal, text: '', cursor: 0 } : { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('ui.render', (_$, e) => {
    seen.rendered.push(e.props)
    return { type: 'engine', ref: 1 } as any
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'BASE', scope: 'shared' }] }))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('tool.call', (_$, e) => ({ result: `out of ${e.tool}`, text: `out of ${e.tool}` }) as any)
  const session = w.session ?? { id: ID }
  on('agent.list', () => ({ value: (w.agents ?? []) as any }))
  on('session.id', () => ({ value: session.id }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: w.tokens, window: 200000 }, rateLimits: [] } }))
  on('fs.list', async (_$, e) => {
    if (e.path === ARCHIVE) {
      const now = await clock.now()
      return { value: [...files].filter(([p]) => p.startsWith(`${ARCHIVE}/`)).map(([p, f]) => ({ name: p.slice(ARCHIVE.length + 1), kind: 'file' as const, size: f.size, mtimeMs: now - f.ageDays * DAY, isLink: false })) }
    }
    expect(e.path).toBe(PROJECTS)
    const entry = (name: string, kind: 'dir' | 'file') => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })
    return { value: [entry('-other', 'dir'), entry('README', 'file'), entry('-work-proj', 'dir')] }
  })
  on('fs.exists', (_$, e) => ({ value: w.exists !== false && (e.path === `${PROJECTS}/-work-proj/${session.id}.jsonl` || e.path in seen.writes || files.has(e.path) || (e.path === ARCHIVE && [...files.keys()].some(p => p.startsWith(`${ARCHIVE}/`)))) }))
  on('fs.write', (_$, e) => {
    seen.writes[e.path] = e.text
    return { value: undefined }
  })
  on('process.spawn', async function* (_$, e) {
    const path = e.argv.at(-1)!
    expect(e.argv).toEqual(['grep', '-v', '-e', '^{"type":"api-request', path])
    // the session's own transcript, or a fork of it as written, then what the session wrote into it after the switch
    const text = path === SRC ? serializeTranscript(w.rows() as any) : seen.writes[path] + serializeTranscript((w.appended ?? []) as any)
    const middle = Math.floor(text.length / 2) // a piece ends wherever the child's write did, mid-line included
    for (const piece of [text.slice(0, middle), text.slice(middle)]) if (piece !== '') yield { stream: 'stdout' as const, text: piece }
    yield { stream: 'stderr' as const, text: 'boom' }
    return { value: { code: w.readExit ?? 0, signal: null } }
  })
  on('process.run', (_$, e) => {
    const [cmd, ...args] = e.argv
    const result = (exitCode: number, stdout = '', stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (cmd === 'dd') {
      seen.writes[args[0]!.replace('of=', '')] = e.init!.stdin!
      return result(w.writeExit ?? 0, '', 'full')
    }
    seen.shell.push([...e.argv])
    if (cmd === w.failing) return result(1, '', 'denied')
    if (cmd === 'grep') {
      const title = files.get(args.at(-1)!)?.title
      return title === undefined ? result(1) : result(0, `"aiTitle":"first"\n"aiTitle":"${title}"\n`)
    }
    if (cmd === 'mv') {
      const [from, to] = args as [string, string]
      const file = files.get(from)
      if (file) {
        files.delete(from)
        files.set(`${to}${from.slice(from.lastIndexOf('/') + 1)}`, file)
      }
    }
    if (cmd === 'rm') for (const path of args.slice(2)) files.delete(path)
    return result(0)
  })
  on('command.register', (_$, e) => {
    seen.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', (_$, e) => {
    seen.tools.push(e)
    return { value: { tool: TOOL } }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('command.run', (_$, e) => {
    seen.resumes.push(`${e.command} ${e.args}`)
    if (session.switchOnResume) session.id = e.args
    return {}
  })
  return { clock, seen, files }
}

export function conversation() {
  const t = new Transcript()
  t.prompt('goal', 'm0001') // 0
  t.call('Read', { file_path: '/a' }, { ref: 'm0002', output: 'AAA' }) // 1-3
  t.call('Bash', { command: 'ls' }, { ref: 'm0003', output: 'BBB' }) // 4-6
  t.text('all done') // 7
  return t
}
export const clones = (seen: { writes: Record<string, string> }) => Object.keys(seen.writes).filter(p => p.endsWith('.jsonl'))
export const complete = ($: any, answer = 'all done', usage?: unknown) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', usage })
export const start = ($: any) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
export const submit = ($: any, text = 'hi', extra = {}) => $.prompt.submit({ text, ...extra })
export const compress = ($: any, content: unknown[]) => $.tool.call({ tool: TOOL, topic: 'T', content })

