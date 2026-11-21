import type { AgentStatus, Hook, Register, RenderElement } from 'claude-code'
import type {} from '../dispatcher/types'

import { applyCompression, staleCopies } from './apply'
import { ARCHIVE, OUTPUTS, archiveSession, listArchive, pruneArchive, restoreSession } from './archive'
import { claudeDir, commands, exec, run } from './platform'
import { type CompressArgs, type CompressConfig, type Plan, PlanError, type Queued, UNKNOWN_ID, itemBody, keptOf, keptUserCount, mergeQueue, planCompression } from './compress'
import { messageRef, tagLine, trailingRef } from './ids'
import { COMPRESS_TOOL, COMPRESSED_BLOCK_HEADER, DuplicateIdError, type Index, indexRows } from './model'
import { continuePrompt, iterationNudge, limitNudge, MERGE_HINT, prunePrompt, queuedResult, systemPrompt, toolDescription } from './prompts'
import { answeredRequests, approxTokens, blockReport, formatTokens, historyReport, resolveLimit, rowChars, tokensOf, tokensPerChar, userReport } from './nudges'
import { isProtected } from './protected'
import { foldCompressInput, STUB_LIMIT_CHARS, STUB_MAX_CHARS, stopPrompt, stopTier } from './stop'
import { applyPrunes, callSignature, markPruned, staleReminders, type StrategyConfig } from './strategies'
import { emptyStats, hashSignature, isAwaitingFirst, recordCall, recordFirstRequest, recordFork, recordTurn, renderStats, savedTokens, type Stats, type TurnUsage } from './stats'
import { assertAnswered, assertCurrent, parseTranscript, serializeTranscript } from './transcript'
import type { Row } from './rows'

export type Dollar = Parameters<Hook<'turn.complete'>>[0]
type Config = CompressConfig &
  StrategyConfig & {
    maxContextLimit: string
    minContextLimit: string
    nudgeFrequency: number
    summaryBuffer: boolean
    minRemovedShare: number
    archiveDays: number
  }

const TOOL_NAME = 'compress'
const LOG_LINES = 200
const READ_ATTEMPTS = 10
const READ_INTERVAL_MS = 500
const RESUME_DELAY_MS = 1000
/** Tool results into a turn after which, over the min limit, the model is reminded to compress what has closed. */
const ITERATION_NUDGE_AFTER = 15

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    topic: { type: 'string', description: 'Three to five word label for the compression' },
    content: {
      type: 'array',
      description: 'Ranges to replace, each with its two boundary IDs and a summary',
      items: {
        type: 'object',
        properties: {
          startId: { type: 'string', description: 'First ID of the range: mNNNN or bN' },
          endId: { type: 'string', description: 'Last ID of the range: mNNNN or bN' },
          summary: { type: 'string', description: 'Text that stands in for everything in the range' },
          save: { type: 'array', items: { type: 'string' }, description: 'IDs of tool outputs in the range to keep in files instead of dropping' },
          drop: { type: 'array', items: { type: 'string' }, description: 'IDs of user messages in the range to drop; allowed only past the kept-user-message limit' },
        },
        required: ['startId', 'endId', 'summary'],
      },
    },
  },
  required: ['topic', 'content'],
}

async function log($: Dollar, line: string) {
  const path = `${await claudeDir($)}/dcp.log`
  const lines = (await $.fs.exists(path)) ? (await $.fs.read(path)).split('\n').slice(0, -1) : []
  lines.push(`${new Date(await $.clock.now()).toISOString()} ${line}`)
  await $.fs.write(path, lines.slice(-LOG_LINES).join('\n') + '\n')
}

async function report($: Dollar, err: unknown) {
  const message = `dcp: ${err instanceof Error ? err.message : String(err)}`
  await $.ui.toast(message)
  await log($, `ERROR ${message}`)
}

/** A session's queue and stats, each in its own file named by session id: the plugin store is one capped (4 MiB) value shared
    by every session, where one full session would refuse every other's writes. */
const sessionFile = async ($: Dollar, id: string, kind: 'queue' | 'stats') => `${await claudeDir($)}/dcp/${id}.${kind}.json`

async function readSession<T>($: Dollar, id: string, kind: 'queue' | 'stats', empty: () => T): Promise<T> {
  const path = await sessionFile($, id, kind)
  if (!(await $.fs.exists(path))) return empty()
  const text = await $.fs.read(path)
  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new Error(`could not parse ${path}: ${(err as Error).message}`)
  }
}

const writeSession = async ($: Dollar, id: string, kind: 'queue' | 'stats', value: unknown) => $.fs.write(await sessionFile($, id, kind), JSON.stringify(value))
const readQueue = ($: Dollar, id: string) => readSession<Queued[]>($, id, 'queue', () => [])
const writeQueue = ($: Dollar, id: string, queue: Queued[]) => writeSession($, id, 'queue', queue)
const readStats = ($: Dollar, id: string) => readSession<Stats>($, id, 'stats', emptyStats)
const writeStats = ($: Dollar, id: string, stats: Stats) => writeSession($, id, 'stats', stats)
const SESSION_FILE = /^(?:dcp-status-(.+)|(.+)\.(?:queue|stats)\.json)$/

/** Deletes the session files and status files of sessions without a transcript, live or archived: Claude Code deletes old
    transcripts, and pruneArchive deletes archived ones. */
async function sweepSessions($: Dollar) {
  const home = await claudeDir($)
  const projects = `${home}/projects`
  const known = new Set<string>()
  const addTranscripts = async (dir: string) => {
    for (const file of await $.fs.list(dir)) if (file.kind === 'file' && file.name.endsWith('.jsonl')) known.add(file.name.slice(0, -6))
  }
  for (const dir of await $.fs.list(projects)) {
    if (dir.kind !== 'dir') continue
    await addTranscripts(`${projects}/${dir.name}`)
    if (await $.fs.exists(`${projects}/${dir.name}/${ARCHIVE}`)) await addTranscripts(`${projects}/${dir.name}/${ARCHIVE}`)
  }
  const gone = (dir: string, names: string[]) =>
    names.flatMap(name => {
      const match = SESSION_FILE.exec(name)
      return match && !known.has(match[1] ?? match[2]!) ? [`${dir}/${name}`] : []
    })
  const fileNames = async (dir: string) => (await $.fs.list(dir)).filter(e => e.kind === 'file').map(e => e.name)
  const stale = [...gone(home, (await fileNames(home)).filter(name => name.startsWith('dcp-status-'))), ...((await $.fs.exists(`${home}/dcp`)) ? gone(`${home}/dcp`, await fileNames(`${home}/dcp`)) : [])]
  if (stale.length === 0) return
  await run($, (await commands($)).remove(stale))
  await log($, `deleted ${stale.length} file(s) of sessions without a transcript`)
}

const outputsDir = (path: string) => `${path.slice(0, path.lastIndexOf('/'))}/${OUTPUTS}`

// The session's cwd moves with every `cd` the model runs, and Claude Code moves the transcript between project folders when
// the session enters or leaves a worktree; so the transcript is looked up by session id at every read, never derived or kept.
async function findTranscript($: Dollar, id: string): Promise<string | undefined> {
  const projects = `${await claudeDir($)}/projects`
  for (const entry of await $.fs.list(projects)) {
    if (entry.kind === 'dir' && (await $.fs.exists(`${projects}/${entry.name}/${id}.jsonl`))) return `${projects}/${entry.name}/${id}.jsonl`
  }
  return undefined
}

// The per-request API logs are a third of a transcript and grow quadratically. A transcript of several MiB exceeds what
// `$.fs.read` and `$.process.run` copy (4 MiB), so it is streamed through an outside command instead.
async function readTranscript($: Dollar, path: string): Promise<Row[]> {
  const { argv, env } = (await commands($)).readTranscript(path)
  const child = $.process.spawn({ argv, env, cwd: await claudeDir($) })
  let [stdout, stderr] = ['', '']
  for (let step = await child.next(); ; step = await child.next()) {
    if (step.done) {
      if (step.value.code !== 0) throw new Error(`could not read the whole transcript ${path}: exit ${step.value.code}, signal ${step.value.signal}, ${stderr}`)
      return parseTranscript(stdout, path)
    }
    if (step.value.stream === 'stdout') stdout += step.value.text
    else stderr += step.value.text
  }
}

async function writeTranscript($: Dollar, path: string, rows: readonly Row[]) {
  const { exitCode, stderr } = await exec($, (await commands($)).writeTranscript(path), { stdin: serializeTranscript(rows), timeoutMs: 120_000 })
  if (exitCode !== 0) throw new Error(`could not write the transcript ${path}: exit ${exitCode}, ${stderr}`)
}

/** Thrown by a `readWhen` check when the transcript has not caught up with the session yet; any other error ends the wait.
    Seen by the model as a plain refusal once the attempts run out. */
class LagError extends Error {}

async function loadTranscript($: Dollar): Promise<{ rows: Row[]; path: string }> {
  const id = await $.session.id()
  const path = await findTranscript($, id)
  if (!path) throw new LagError(`no transcript found for session ${id}`)
  return { rows: await readTranscript($, path), path }
}

/** Reads until `ready` holds (the file is written asynchronously), throwing the last failure after the attempts. */
async function readWhen<T>($: Dollar, ready: (rows: Row[], path: string) => T): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { rows, path } = await loadTranscript($)
      return ready(rows, path)
    } catch (err) {
      if (attempt === READ_ATTEMPTS || !(err instanceof LagError)) throw err
      await $.clock.sleep(READ_INTERVAL_MS)
    }
  }
}

/** `applyPending`: a compress call queued ranges, so the next model request of the turn stops the turn to apply them.
    `stopped`: the turn was stopped for that; its end forks and continues the work in the fork.
    `ran`: the ids of the turn's tool calls, whose results the transcript must hold before a fork copies it.
    `turns`: main-loop turns started in this process; a fork made before the latest one lacks its work.
    `forking`: the fork awaiting its idle-time resume hook; a second fork would race it.
    `ending`: the Stop hook held the turn back to ask for a compress; the turn has no work left, so its compression forks at its end. */
type State = {
  nextRef: number
  seeded: boolean
  allocating: Promise<unknown>
  toolsThisTurn: number
  sinceNudge: number
  queuedThisTurn: boolean
  applyPending: boolean
  stopped: boolean
  ran: string[]
  turns: number
  forking: { from: string; to: string; turns: number; current: (rows: Row[], path: string) => void; forced: boolean; then?: (removed: string) => Promise<unknown> } | null
  pruning: boolean
  ending: boolean
  active: boolean
  status: string | undefined
}

const resetTurn = (state: State) => Object.assign(state, { toolsThisTurn: 0, sinceNudge: Infinity, queuedThisTurn: false, applyPending: false, stopped: false, ran: [], ending: false })

/** Submits a prompt of this plugin's own. $.prompt.submit skips the calling plugin's prompt.submit hook, so the turn is reset here. */
async function submitOwn($: Dollar, state: State, text: string) {
  resetTurn(state)
  await $.prompt.submit({ text, asUser: true })
}

function guidance(idx: Index, rows: readonly Row[], scale: number) {
  return [blockReport(idx.blocks, scale), historyReport(rows, idx, scale), userReport(keptUserCount(rows, idx))].filter(s => s.length > 0).join('\n\n')
}

/** The max limit, raised by the tokens the active summaries hold. */
function maxLimit(config: Config, window: number, idx: Index, scale: number): number {
  const buffer = config.summaryBuffer ? [...idx.blocks.values()].reduce((total, b) => total + tokensOf(b.summary.length, scale), 0) : 0
  return resolveLimit(config.maxContextLimit, window) + buffer
}

/** The engine's context figure is the old session's until the first request after a fork; nothing is decided on it then. */
async function figuresStale($: Dollar): Promise<boolean> {
  return isAwaitingFirst(await readStats($, await $.session.id()))
}

/** The nudge after a tool result, at most every `nudgeFrequency` results: over the max, the limit nudge; over the min and many results
    into the turn, the iteration nudge; nothing while a compression waits for the next request to apply it. */
async function computeNudges($: Dollar, config: Config, state: State): Promise<string[]> {
  if (state.sinceNudge < config.nudgeFrequency || state.applyPending) return []
  const { context } = await $.session.usage()
  if (context.tokens === undefined || context.tokens < resolveLimit(config.minContextLimit, context.window)) return []
  const iterating = state.toolsThisTurn >= ITERATION_NUDGE_AFTER
  if ((!iterating && context.tokens <= resolveLimit(config.maxContextLimit, context.window)) || (await figuresStale($))) return []
  const { rows } = await loadTranscript($)
  const idx = indexRows(rows)
  const scale = tokensPerChar(rows)
  if (scale === undefined) return []
  const over = context.tokens > maxLimit(config, context.window, idx, scale)
  if (!over && !iterating) return []
  state.sinceNudge = 0

  return [(over ? limitNudge : iterationNudge)(COMPRESS_TOOL, guidance(idx, rows, scale))]
}

/** A failure here would otherwise only be a skipped hook (no tags, no nudges, no trace), so it is reported before it propagates. */
async function reported<T>($: Dollar, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    await report($, err)
    throw err
  }
}

/** What to tell the model when it is about to stop, by how full the context is; undefined when nothing is worth asking. */
async function stopReason($: Dollar, config: Config, state: State): Promise<string | undefined> {
  if (state.queuedThisTurn || (await figuresStale($))) return undefined
  const { context } = await $.session.usage()
  if (context.tokens === undefined) return undefined
  const min = resolveLimit(config.minContextLimit, context.window)
  if (context.tokens < min && state.toolsThisTurn === 0) return undefined
  const { rows } = await loadTranscript($)
  const idx = indexRows(rows)
  const scale = tokensPerChar(rows)
  if (scale === undefined) return undefined
  const tier = stopTier(context.tokens, min, maxLimit(config, context.window, idx, scale))
  const advice = tier === 'drop' ? historyReport(rows, idx, scale) : guidance(idx, rows, scale)

  return [stopPrompt(tier, COMPRESS_TOOL), advice].filter(part => part.length > 0).join('\n\n')
}

/** Validates the call against the transcript and queues its ranges for the next fork, folded into those queued before. */
async function queueCompress($: Dollar, config: Config, state: State, args: CompressArgs): Promise<string> {
  const plans = await readWhen($, (rows, path) => {
    try {
      return planCompression(rows, indexRows(rows), args, config, outputsDir(path))
    } catch (err) {
      throw err instanceof PlanError && err.message.includes(UNKNOWN_ID) ? new LagError(err.message) : err
    }
  })
  if (!state.pruning) await assertStubsUnderMin($, config, args, plans)
  const id = await $.session.id()
  const { queue, notes } = mergeQueue(await readQueue($, id), plans)
  await writeQueue($, id, queue)
  Object.assign(state, { sinceNudge: Infinity, queuedThisTurn: true, applyPending: true })
  return queuedResult(plans.filter(p => queue.some(q => q.entry === p.entry)).reduce((n, p) => n + p.messageCount, 0), notes, await agentsBusy($))
}

/** Under the min limit nothing is paraphrased: a range may only be dropped, with a stub for a summary, and may not cover a block,
    whose summary the stub would replace. */
async function assertStubsUnderMin($: Dollar, config: Config, args: CompressArgs, plans: readonly Plan[]) {
  const { context } = await $.session.usage()
  if (context.tokens === undefined || context.tokens >= resolveLimit(config.minContextLimit, context.window)) return
  const merging = plans.filter(p => p.consumedBlockIds.length > 0).map(p => `${p.entry.startId}..${p.entry.endId} covers ${p.consumedBlockIds.map(n => `b${n}`).join(', ')}`)
  if (merging.length > 0) throw new PlanError(`Context is ${formatTokens(context.tokens)}, under the ${config.minContextLimit} limit: blocks can be merged only above it, so ranges must not cover them. ${merging.join(', ')}.`)
  const long = args.content.filter(c => c.summary.length > STUB_LIMIT_CHARS).map(c => `${c.startId}..${c.endId} has ${c.summary.length}`)
  if (long.length > 0)
    throw new PlanError(`Context is ${formatTokens(context.tokens)}, under the ${config.minContextLimit} limit: summaries must be stubs of about ${STUB_MAX_CHARS} characters, ${STUB_LIMIT_CHARS} at most (what was dropped and why). ${long.join(', ')}.`)
}

/** The id of Claude Code's auto-memory section in the system prompt (verified on 2.1.316); absent when auto memory is off. */
const MEMORY_SECTION = 'memory'

const BUSY_STATUSES: AgentStatus[] = ['pending', 'running', 'waiting']

// the fork moves the old session's folder, which holds the subagents' transcripts: wait until none is working
async function agentsBusy($: Dollar) {
  return (await $.agent.list()).some(a => BUSY_STATUSES.includes(a.status))
}

/** Whether a fork that removes `removed` characters is worth the cache rewrite it causes: everything from its first change on is written again. */
const paysForRewrite = (config: Config, removed: number, rewritten: number) => removed >= config.minRemovedShare * rewritten

/** Characters in tokens at the conversation's measured rate; in characters while it has no rate yet. */
const sized = (chars: number, scale: number | undefined) => (scale === undefined ? `${chars} characters` : approxTokens(tokensOf(chars, scale)))

/** `removed` and `rewritten` are characters; `scale` is undefined while the conversation has no rate to turn them into tokens. */
type Draft = { idx: Index; plans: Plan[]; pruned: Set<string>; out: Row[]; scale: number | undefined; removed: number; rewritten: number }

/** The transcript as the fork would write it, with what it removes and what it makes the cache rewrite: everything from its first change on. */
function draftFork(rows: readonly Row[], path: string, queued: readonly Queued[], config: Config, to: string): Draft {
  const idx = indexRows(rows)
  const plans = planCompression(rows, idx, { topic: 'queued', content: queued.map(q => q.entry) }, config, outputsDir(path))
  const pruned = markPruned(idx, config)
  const out = applyCompression(applyPrunes(rows, idx, pruned), idx, plans, { sessionId: to, newUuid: () => crypto.randomUUID() })
  const firstChanged = Math.min(...plans.map(p => p.s), ...idx.calls.filter(c => pruned.has(c.id)).map(c => c.useRow), ...staleCopies(rows), ...staleReminders(rows))
  return { idx, plans, pruned, out, scale: tokensPerChar(rows), removed: rowChars(rows) - rowChars(out), rewritten: rowChars(out.slice(firstChanged)) }
}

/** Whether a fork is worth making now: it removes enough for its cache rewrite, or the context is over the max, which needs the rate
    the summaries are sized by. Logs why it waits otherwise. */
async function forkPays($: Dollar, config: Config, draft: Draft): Promise<boolean> {
  const { context } = await $.session.usage()
  if (context.tokens === undefined) throw new Error('no request has been answered yet, so the size of the context is unknown')
  if (paysForRewrite(config, draft.removed, draft.rewritten) || (draft.scale !== undefined && context.tokens > maxLimit(config, context.window, draft.idx, draft.scale))) return true
  await log($, `fork waits: it would remove ${sized(draft.removed, draft.scale)} and make the cache rewrite ${sized(draft.rewritten, draft.scale)} (minRemovedShare ${config.minRemovedShare})`)

  return false
}

/** One pending switch per session. The idle-time resume hook reads the latest completed turn and queue. */
async function forkQueued($: Dollar, state: State, turns: number, current: (rows: Row[], path: string) => void, forced: boolean, then?: (removed: string) => Promise<unknown>): Promise<boolean> {
  const from = await $.session.id()
  if (state.forking) {
    if (state.forking.from !== from) throw new Error(`pending fork belongs to ${state.forking.from}, not ${from}`)
    Object.assign(state.forking, { turns, current, forced: state.forking.forced || forced, then })
    return true
  }
  const pending: NonNullable<State['forking']> = { from, to: crypto.randomUUID(), turns, current, forced, then }
  state.forking = pending
  $.clock.after(RESUME_DELAY_MS, async () => {
    try {
      await $.dcpDispatch.resume({ sessionId: pending.to })
    } catch (err) {
      if (state.forking === pending) state.forking = null
      await report($, err)
    }
  })
  return true
}

/** Called only inside the host's idle-time command dispatch, never from a turn-complete hook. */
async function resumeFork($: Dollar, config: Config, state: State, next: () => Promise<unknown>) {
  const fork = state.forking!
  const { from, to, turns, current, forced, then } = fork
  const assertIdle = async () => {
    const id = await $.session.id()
    if (id !== from || state.turns !== turns) throw new Error(`fork ${to} refused: session ${id}, turn ${state.turns}; expected ${from}, completed turn ${turns}; source transcript and queue retained`)
  }
  try {
    await assertIdle()
    if (await agentsBusy($)) throw new Error(`fork ${to} refused: a background agent is working; source transcript and queue retained`)
    const { rows, path } = await readWhen($, (rows, path) => {
      try {
        current(rows, path)
      } catch (err) {
        throw new LagError((err as Error).message)
      }
      return { rows, path }
    })
    const draft = draftFork(rows, path, await readQueue($, from), config, to)
    if (!forced && !(await forkPays($, config, draft))) return {}
    const { idx, plans, pruned, out, scale, removed, rewritten } = draft
    const { context } = await $.session.usage()
    const dir = path.slice(0, path.lastIndexOf('/'))
    const saves = plans.flatMap(p => p.saves)
    if (saves.length > 0) await run($, (await commands($)).mkdir(outputsDir(path)))
    for (const { path: file, text } of saves) await $.fs.write(file, text)
    await writeTranscript($, `${dir}/${to}.jsonl`, out)
    const gone = idx.calls.filter(c => plans.some(p => c.useRow >= p.s && c.useRow <= p.e) && !isProtected(c.name, c.input, config.protectedTools, config.protectedFilePatterns)).map(c => hashSignature(callSignature(c.name, c.input)))
    const estimated = scale === undefined ? undefined : tokensOf(removed, scale)
    const stats = recordFork(await readStats($, from), { before: context.tokens!, estimated, copied: out.length, gone })
    await writeStats($, to, stats)
    const delta = `${sized(Math.abs(removed), scale)} ${removed >= 0 ? 'removed' : 'added'}`
    const pending = `${delta} (estimated; measured at the next reply)`
    await log($, `forked ${from} -> ${to}: ${plans.length} ranges compressed, ${pruned.size} tool calls pruned, ${pending}, cache rewrite ${sized(rewritten, scale)}; resuming`)
    const draftText = (await $.prompt.read()).text
    await assertIdle()
    const result = await next()
    const id = await $.session.id()
    if (id !== to) throw new Error(`switch to ${to} did not happen; session is ${id}`)
    // Work may already have run in the fork when next returns. Never roll back or delete it.
    state.forking = null
    if (draftText.length > 0) {
      const after = (await $.prompt.read()).text
      if (after.length > 0 && after !== draftText) await report($, new Error(`draft changed during the switch; newer text retained; unsent draft before the switch was: ${draftText}`))
      else if (after.length === 0) {
        const { isFilled, refusal } = await $.prompt.fill({ text: draftText, mode: 'append' })
        if (!isFilled) throw new Error(`could not put the unsent draft back after the switch (${refusal ?? 'refused by a hook'}); it was: ${draftText}`)
      }
    }
    const jobs = await archiveSession($, dir, from, to)
    const deleted = await pruneArchive($, dir, config.archiveDays)
    await run($, (await commands($)).remove([await statusFile($, from), await sessionFile($, from, 'queue')]))
    await log($, `now in ${id}, forked from ${from}, which is archived (${deleted} older archived session(s) deleted); background jobs now resuming ${to}: ${jobs.join(', ') || 'none'}`)
    await $.ui.toast(`dcp: compressed ${plans.length} range(s), pruned ${pruned.size} tool call(s): ${pending}`)
    await pin($, state, `${removed >= 0 ? 'compressed' : 'grew'} ${sized(Math.abs(removed), scale)} (estimate)`)
    if (then) $.clock.after(0, async () => { await reported($, () => then(delta)) })
    return result
  } finally {
    if (state.forking === fork) state.forking = null
  }
}

/** Whether the turn should stop before its next request so the queued compressions apply now: no subagent works, and the fork pays.
    Judged on the transcript as it stands, which may lag the latest tool results; they weigh little against the ranges. */
async function stopForFork($: Dollar, config: Config, state: State): Promise<boolean> {
  if (state.forking || (await agentsBusy($))) return false
  const { rows, path } = await loadTranscript($)
  return forkPays($, config, draftFork(rows, path, await readQueue($, await $.session.id()), config, 'draft'))
}

/** The usage of the first request the model answered after a fork: the first one beyond the rows the fork copied. */
async function firstRequestAfter($: Dollar, copied: number): Promise<TurnUsage> {
  return readWhen($, rows => {
    const request = answeredRequests(rows).find(r => r.first >= copied)
    if (request === undefined) throw new LagError(`no answered request after the ${copied} rows the fork copied`)

    return request.usage
  })
}

/** Adds the finished turn to the lineage's stats; a turn that counted nothing (an interrupt, an API error) has no usage.
    The first turn after a fork also settles what that fork removed, from its first request. */
async function recordTurnStats($: Dollar, usage: TurnUsage | undefined) {
  const { context } = await $.session.usage()
  if (usage === undefined || context.tokens === undefined) return
  const id = await $.session.id()
  let stats = await readStats($, id)
  if (isAwaitingFirst(stats)) stats = recordFirstRequest(stats, await firstRequestAfter($, stats.segments.at(-1)!.copied!))
  await writeStats($, id, recordTurn(stats, context.tokens, usage))
}

/** Notes a call of the main loop that repeats one compressed away; `input` carries the tool's arguments beside the engine's own keys. */
async function noteCall($: Dollar, tool: string, input: Record<string, any>) {
  const { tool: _tool, tool_use_id: _id, consent: _consent, agentId: _agent, ...args } = input
  const id = await $.session.id()
  const stats = await readStats($, id)
  const noted = recordCall(stats, hashSignature(callSignature(tool, args)))
  if (noted !== stats) await writeStats($, id, noted)
}

const statusFile = async ($: Dollar, id: string) => `${await claudeDir($)}/dcp-status-${id}`

/** Shows the text at the end of the hint line under the prompt and writes it where the user's statusLine command can read it.
    Not `$.ui.status`: the terminal draws that one as a warning, with a ⚠. */
async function pin($: Dollar, state: State, text: string) {
  state.status = text
  $.ui.invalidate('ui.render')
  await $.fs.write(await statusFile($, await $.session.id()), text)
}

/** Pins the real context size and the saving measured so far of this session's lineage under the prompt. */
async function showStatus($: Dollar, state: State) {
  const { context } = await $.session.usage()
  if (context.tokens === undefined) return
  await pin($, state, `context ${formatTokens(context.tokens)} / ${formatTokens(context.window)} (${Math.round((context.tokens / context.window) * 100)}%) · saved ${formatTokens(savedTokens(await readStats($, await $.session.id())))} so far`)
}

/** A command's output; a failure is its output too, since the engine would skip a hook that throws and print nothing. */
async function answer($: Dollar, work: () => Promise<string>) {
  try {
    return { text: await work() }
  } catch (err) {
    await log($, `ERROR dcp: ${err instanceof Error ? err.message : String(err)}`)

    return { text: `dcp: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 }
  }
}

/** The project folder that holds this session's transcript, and with it the archive. */
async function projectDir($: Dollar): Promise<string> {
  const id = await $.session.id()
  const path = await findTranscript($, id)
  if (!path) throw new Error(`no transcript found for session ${id}`)

  return path.slice(0, path.lastIndexOf('/'))
}

/** The next message id, continuing after the highest one in the session's transcript. The transcript is read at the first tag
    that finds it, not at session start, when a resumed session's file may not be resolvable yet; a new session has none.
    Parallel tool results ask at once, so each waits for the one before it: two reading the transcript would take the same id. */
function nextMessageRef($: Dollar, state: State): Promise<string> {
  const ref = state.allocating.then(() => allocateRef($, state))
  state.allocating = ref.catch(() => undefined)
  return ref
}

async function allocateRef($: Dollar, state: State): Promise<string> {
  if (!state.seeded) {
    const id = await $.session.id()
    const path = await findTranscript($, id)
    if (path) {
      state.nextRef = Math.max(state.nextRef, indexRows(await readTranscript($, path)).maxMessageRef)
      state.seeded = true
    } else await log($, `no transcript for session ${id} yet: numbering messages from ${state.nextRef + 1}`)
  }

  return messageRef(++state.nextRef)
}

/** Every live Claude Code process keeps `sessions/<pid>.json` naming its session. Two on one session (a `--resume` of a
    session still open elsewhere) append two branches to one transcript, each numbering its own messages, so ids repeat. */
async function sharedSessionError($: Dollar): Promise<string | undefined> {
  const id = await $.session.id()
  const pid = (await $.process.hookEnv()).CLAUDE_PID
  if (!pid) throw new Error('cannot tell which Claude Code process this is: the hook environment has no CLAUDE_PID')
  const own = Number(pid)
  const dir = `${await claudeDir($)}/sessions`
  const entries = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.json'))
  const live = (await Promise.all(entries.map(async f => JSON.parse(await $.fs.read(`${dir}/${f.name}`)) as { pid: number; sessionId: string; name?: string; tmux?: string })))
    .filter(p => p.sessionId === id)
  const others = live.filter(p => p.pid !== own)
  if (others.length === 0) return undefined
  const named = (p: { pid: number; name?: string; tmux?: string }) => `pid ${p.pid} (${[p.name, p.tmux && `tmux ${p.tmux}`].filter(Boolean).join(', ')})`
  const self = live.find(p => p.pid === own)

  return `your prompt was not sent: this session (${id}) is also open in another Claude Code process, ${others.map(named).join(', ')}, and both writing its history corrupts it. This one is ${self ? named(self) : `pid ${own}`}. Close one of them, then send your prompt again.`
}

/** A `-p` or SDK run never uses the compressed session, so it pays no tokens for dcp unless DCP_HEADLESS=1 asks for it. */
async function startSession($: Dollar, state: State, isInteractive: boolean) {
  state.active = false
  if (!isInteractive && (await $.env.get('DCP_HEADLESS')) !== '1') return
  try {
    const failure = await $.dcpDispatch.failure({ sessionId: await $.session.id() })
    if (failure !== null) throw new Error(failure)
  } catch (err) {
    const error = new Error(`dcp-dispatcher startup check failed: ${err instanceof Error ? err.message : String(err)}; see README.md#install`)
    await report($, error)
    throw error
  }
  state.active = true
  resetTurn(state)
  await $.command.register({ name: 'dcp-archive', description: 'List sessions dcp archived after compressing' })
  await $.command.register({ name: 'dcp-restore', description: 'Restore an archived session for /resume', argumentHint: '<session id>' })
  await $.command.register({ name: 'dcp-prune', description: 'Ask the model to compress closed work now', argumentHint: '[hint]' })
  await $.command.register({ name: 'dcp-stats', description: 'Show tokens dcp removed and the cache rewrites it caused' })
  await $.tool.register({
    name: TOOL_NAME,
    description: toolDescription(COMPRESS_TOOL),
    inputSchema: INPUT_SCHEMA,
    isDeferred: false,
  })
  await reported($, () => sweepSessions($))
}

export const register: Register = (on, options) => {
  const config = options as unknown as Config
  const state: State = { nextRef: 0, seeded: false, allocating: Promise.resolve(), toolsThisTurn: 0, sinceNudge: Infinity, queuedThisTurn: false, applyPending: false, stopped: false, ran: [], turns: 0, forking: null, pruning: false, ending: false, active: false, status: undefined }

  on('session.start', async ($, e, next) => {
    await startSession($, state, e.isInteractive)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    if (!state.active) return next(e)
    const { sections } = await next(e)

    return { sections: [...sections, { id: 'dcp:system', text: systemPrompt(COMPRESS_TOOL, config.protectedTools, sections.some(s => s.id === MEMORY_SECTION)), scope: 'session' as const }] }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!state.active || e.isMeta) return next(e)
    const shared = await reported($, () => sharedSessionError($))
    if (shared !== undefined) {
      await report($, new Error(shared))
      return { drop: `dcp: ${shared}` }
    }
    resetTurn(state)

    return next({ ...e, context: [...(e.context ?? []), tagLine(await nextMessageRef($, state)).trim()] })
  })

  on('tool.call', async ($, e, next) => {
    if (!state.active) return next(e)
    if (e.agentId !== undefined) return e.tool === COMPRESS_TOOL ? { deny: `${COMPRESS_TOOL} is for the main conversation only; a subagent's messages carry no ids.` } : next(e)
    let result
    if (e.tool !== COMPRESS_TOOL) await noteCall($, e.tool, e)
    if (e.tool === COMPRESS_TOOL) {
      try {
        result = { result: await queueCompress($, config, state, e as unknown as CompressArgs) }
      } catch (err) {
        if (err instanceof PlanError || err instanceof LagError || err instanceof DuplicateIdError) return { deny: err.message }
        throw err
      }
    } else result = await next(e)
    if (result.deny !== undefined || next.signal.aborted) return result
    state.ran.push(e.tool_use_id)
    state.toolsThisTurn++
    state.sinceNudge++
    const nudges = await reported($, () => computeNudges($, config, state))

    return { ...result, context: [...(result.context ?? []), ...nudges, tagLine(await nextMessageRef($, state)).trim()] }
  })

  // $.command.run queues until idle. Check here, not before queueing or after it returns (a turn in the fork can delay that return).
  on('command.run', { command: 'resume' }, async ($, e, next) => {
    const fork = state.forking
    if (fork === null || e.args.trim() !== fork.to) return next(e)
    try {
      return await resumeFork($, config, state, () => next(e)) as Awaited<ReturnType<typeof next>>
    } catch (err) {
      // A thrown command hook is skipped by the host: answer explicitly so a refused fork cannot resume.
      await report($, err)
      return {}
    }
  }).catch(async ($, e, next) => {
    const fork = state.forking
    if (fork === null || e.args.trim() !== fork.to) return undefined
    state.forking = null
    await report($, new Error(`resume hook ${next.error.kind}: ${next.error.message ?? 'no error message supplied by the host'}`))
    return {}
  })

  on('command.run', { command: 'dcp-archive' }, async $ => answer($, async () => listArchive($, await projectDir($))))

  on('command.run', { command: 'dcp-restore' }, async ($, e) =>
    answer($, async () => {
      const id = e.args.trim()
      await restoreSession($, await projectDir($), id)

      return `Restored ${id}. Open it with /resume.`
    }),
  )

  on('command.run', { command: 'dcp-prune' }, async ($, e) =>
    answer($, async () => {
      state.pruning = true
      const { context } = await $.session.usage()
      const overMax = context.tokens !== undefined && context.tokens > resolveLimit(config.maxContextLimit, context.window)
      const hint = e.args.trim() || (overMax ? MERGE_HINT : '')
      // the host refuses a submit from inside this hook, which holds the turn the prompt would wait for
      $.clock.after(RESUME_DELAY_MS, async () => {
        try {
          await submitOwn($, state, prunePrompt(COMPRESS_TOOL, hint))
        } catch (err) {
          state.pruning = false
          await report($, err)
        }
      })

      return 'Asked the model to compress closed work.'
    }),
  )

  on('command.run', { command: 'dcp-stats' }, async $ => answer($, async () => renderStats(await readStats($, await $.session.id()))))

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => (state.status === undefined ? next(e) : next({ ...e, props: { ...e.props, tail: `dcp: ${state.status}` } })))

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== COMPRESS_TOOL) return next(e)

    return next({ ...e, props: { ...e.props, input: foldCompressInput(e.props.input) } })
  })

  // A block is stored as a user row, so the terminal would draw its whole summary as a message: fold it to one line, all of it on ctrl+o.
  // The messages it keeps stay drawn under that line, user messages dim as typed input and the agent's as markdown, so the conversation reads on across the fold.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const ref = e.props.text.startsWith(COMPRESSED_BLOCK_HEADER) ? trailingRef(e.props.text) : null
    if (e.props.isExpanded || ref === null) return next(e)
    const line = `${ref} · compressed conversation section · ${formatTokens(e.props.text.length)} chars (ctrl+o to expand)`
    const said = keptOf(e.props.text, 0)
      .filter(k => k.kind !== 'other')
      .map((k): RenderElement => (k.kind === 'user' ? { type: 'Text', props: { dimColor: true }, children: [`> ${itemBody(k)}`] } : { type: 'Markdown', props: { text: itemBody(k) } }))

    return { type: 'Box', props: { flexDirection: 'column', gap: 1 }, children: [{ type: 'Text', props: { dimColor: true }, children: [line] }, ...said] }
  })

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (!state.active || e.stop_hook_active || next.signal.aborted) return result
    const block = await reported($, () => stopReason($, config, state))
    state.ending = block !== undefined

    return block === undefined ? result : { ...result, block }
  })

  // A compression queued mid-turn is applied before the next request: the turn is stopped there, and its end forks, switches and
  // continues the work in the fork with a prompt. The transcript holds the turn's last tool results only once the turn has ended, so
  // the fork waits for that. Without this the context would only shrink when the turn ends, however long it runs.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      state.turns++
      const fork = state.forking
      if (fork !== null) {
        const failure = await $.dcpDispatch.failure({ sessionId: fork.to })
        if (failure !== null) {
          state.forking = null
          await report($, new Error(`dispatch to ${fork.to} failed: ${failure}; source transcript and queue retained`))
        }
      }
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // a /dcp-prune turn, or one the Stop hook held back, forks at its end: it has no task to continue
    if (!state.active || e.agentId !== undefined || !state.applyPending || state.pruning || state.ending) return yield* next(e)
    state.applyPending = false
    if (!(await reported($, () => stopForFork($, config, state)))) return yield* next(e)
    state.stopped = true
    await $.turn.abort({ turnId: e.turnId })

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })

  on('turn.complete', async ($, e, next) => {
    const turns = state.turns // before any await, so a turn that starts meanwhile is seen as newer than the fork
    const result = await next(e)
    if (!state.active || e.agentId !== undefined || next.signal.aborted) return result
    await reported($, () => recordTurnStats($, e.usage))
    await showStatus($, state)
    if (state.stopped) {
      state.stopped = false
      const ran = state.ran
      await reported($, () => forkQueued($, state, turns, (rows, path) => assertAnswered(rows, ran, path), true, removed => submitOwn($, state, continuePrompt(removed))))
      return result
    }
    if (e.reason !== 'answer') return result
    const forced = state.pruning
    state.pruning = false
    if ((await readQueue($, await $.session.id())).length === 0) return result
    if (await agentsBusy($)) return result
    await reported($, () => forkQueued($, state, turns, (rows, path) => assertCurrent(rows, e.answer, path), forced))

    return result
  })
}
