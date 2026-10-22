import type { Dollar } from './register'

const ARCHIVE = 'archive'
const DAY_MS = 86_400_000
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function run($: Dollar, argv: string[]) {
  const { exitCode, stderr } = await $.process.run(argv)
  if (exitCode !== 0) throw new Error(`${argv.join(' ')} failed: exit ${exitCode}, ${stderr}`)
}

/** Moves a session's transcript and its folder (subagents, tool results) between a project folder and its archive. */
async function move($: Dollar, from: string, to: string, id: string) {
  await run($, ['mv', `${from}/${id}.jsonl`, `${to}/`])
  if (await $.fs.exists(`${from}/${id}`)) await run($, ['mv', `${from}/${id}`, `${to}/`])
}

export async function archiveSession($: Dollar, dir: string, id: string) {
  await run($, ['mkdir', '-p', `${dir}/${ARCHIVE}`])
  await move($, dir, `${dir}/${ARCHIVE}`, id)
}

async function archived($: Dollar, dir: string) {
  if (!(await $.fs.exists(`${dir}/${ARCHIVE}`))) return []
  return (await $.fs.list(`${dir}/${ARCHIVE}`)).flatMap(entry => (entry.kind === 'file' && entry.name.endsWith('.jsonl') && SESSION.test(entry.name.slice(0, -6)) ? [{ id: entry.name.slice(0, -6), size: entry.size, mtimeMs: entry.mtimeMs }] : []))
}

/** Deletes the archived sessions last active more than `days` days ago; returns how many. */
export async function pruneArchive($: Dollar, dir: string, days: number): Promise<number> {
  const cutoff = (await $.clock.now()) - days * DAY_MS
  const old = (await archived($, dir)).filter(s => s.mtimeMs < cutoff)
  for (const { id } of old) await run($, ['rm', '-rf', '--', `${dir}/${ARCHIVE}/${id}.jsonl`, `${dir}/${ARCHIVE}/${id}`])

  return old.length
}

async function titleOf($: Dollar, path: string): Promise<string> {
  const { exitCode, stdout, stderr } = await $.process.run(['grep', '-o', '-E', '"aiTitle":"[^"]*"', path])
  if (exitCode === 1) return 'untitled'
  if (exitCode !== 0) throw new Error(`could not read the title of ${path}: exit ${exitCode}, ${stderr}`)

  return stdout.trim().split('\n').at(-1)!.slice('"aiTitle":"'.length, -1)
}

export async function listArchive($: Dollar, dir: string): Promise<string> {
  const sessions = (await archived($, dir)).sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (sessions.length === 0) return 'No archived sessions.'
  const now = await $.clock.now()
  const lines = await Promise.all(
    sessions.map(async s => `${s.id} · ${await titleOf($, `${dir}/${ARCHIVE}/${s.id}.jsonl`)} · ${Math.floor((now - s.mtimeMs) / DAY_MS)}d ago · ${(s.size / 1e6).toFixed(1)} MB`),
  )

  return [...lines, '', 'Restore one with /dcp-restore <id>, then /resume.'].join('\n')
}

export async function restoreSession($: Dollar, dir: string, id: string) {
  if (!SESSION.test(id)) throw new Error(`"${id}" is not a session id; list them with /dcp-sessions`)
  if (!(await $.fs.exists(`${dir}/${ARCHIVE}/${id}.jsonl`))) throw new Error(`no archived session ${id}; list them with /dcp-sessions`)
  if (await $.fs.exists(`${dir}/${id}.jsonl`)) throw new Error(`session ${id} is already in the project`)
  await move($, `${dir}/${ARCHIVE}`, dir, id)
}
