import type { AgentStatus, Hook, Register } from 'claude-code'

import { applyCompression, staleCopies } from './apply'
import { CHILD_CWD, OUTPUTS, archiveSession, exec, listArchive, pruneArchive, restoreSession, run } from './archive'
import { type CompressArgs, type CompressConfig, type Plan, PlanError, type Queued, UNKNOWN_ID, mergeQueue, planCompression } from './compress'
import { messageRef, tagLine, trailingRef } from './ids'
import { COMPRESS_TOOL, COMPRESSED_BLOCK_HEADER, type Index, indexRows } from './model'
import { continuePrompt, iterationNudge, limitNudge, prunePrompt, queuedResult, systemPrompt, toolDescription } from './prompts'
import { answeredRequests, blockReport, formatTokens, historyReport, resolveLimit, rowChars, tokensOf, tokensPerChar } from './nudges'
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
        },
        required: ['startId', 'endId', 'summary'],
      },
    },
  },
  required: ['topic', 'content'],
}

async function log($: Dollar, line: string) {
  const home = await $.env.get('HOME')
  const lines = ((await $.store.get('log')) as string[] | undefined) ?? []
  lines.push(`${new Date(await $.clock.now()).toISOString()} ${line}`)
  const kept = lines.slice(-LOG_LINES)
  await $.store.set('log', kept)
  await $.fs.write(`${home}/.claude/dcp.log`, kept.join('\n') + '\n')
}

async function report($: Dollar, err: unknown) {
  const message = `dcp: ${err instanceof Error ? err.message : String(err)}`
  await log($, `ERROR ${message}`)
  await $.ui.toast(message)
}

// $.store is shared by every session on the machine, so per-session values are keyed by session id.
async function readQueue($: Dollar, id: string): Promise<Queued[]> {
  return ((await $.store.get(`queue2:${id}`)) as Queued[] | undefined) ?? []
}

async function writeQueue($: Dollar, id: string, queue: Queued[]) {
  await $.store.set(`queue2:${id}`, queue)
}

async function readStats($: Dollar, id: string): Promise<Stats> {
  return ((await $.store.get(`stats2:${id}`)) as Stats | undefined) ?? emptyStats()
}

async function writeStats($: Dollar, id: string, stats: Stats) {
  await $.store.set(`stats2:${id}`, stats)
}

// A session's transcript lives in the project folder of the directory it started in, while the session's cwd moves with
// every `cd` the model runs; so the transcript is found by session id, never derived from the cwd.
const transcriptDirs = new Map<string, string>()

const outputsDir = (path: string) => `${path.slice(0, path.lastIndexOf('/'))}/${OUTPUTS}`

async function findTranscript($: Dollar, id: string): Promise<string | undefined> {
  const known = transcriptDirs.get(id)
  if (known) return `${known}/${id}.jsonl`
  const projects = `${await $.env.get('HOME')}/.claude/projects`
  for (const entry of await $.fs.list(projects)) {
    if (entry.kind !== 'dir' || !(await $.fs.exists(`${projects}/${entry.name}/${id}.jsonl`))) continue
    transcriptDirs.set(id, `${projects}/${entry.name}`)
    return `${projects}/${entry.name}/${id}.jsonl`
  }
  return undefined
}

// The per-request API logs are a third of a transcript and grow quadratically. A transcript of several MiB exceeds what
// `$.fs.read` and `$.process.run` copy (4 MiB), so it is streamed through `grep` and `dd` instead.
async function readTranscript($: Dollar, path: string): Promise<Row[]> {
  const child = $.process.spawn({ argv: ['grep', '-v', '-e', '^{"type":"api-request', path], cwd: CHILD_CWD })
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
  const { exitCode, stderr } = await exec($, ['dd', `of=${path}`, 'status=none'], { stdin: serializeTranscript(rows), timeoutMs: 120_000 })
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
    `forking`: a fork is written and its switch pending; a second fork of the same session would race it.
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
  forking: boolean
  pruning: boolean
  ending: boolean
  active: boolean
}

// The prompt that continues a stopped turn resets these too: the fork it runs in has just shed the ranges.
const resetTurn = (state: State) => Object.assign(state, { toolsThisTurn: 0, sinceNudge: Infinity, queuedThisTurn: false, applyPending: false, stopped: false, ran: [], ending: false })

function guidance(idx: Index, rows: readonly Row[], scale: number) {
  return [blockReport(idx.blocks, scale), historyReport(rows, idx, scale)].filter(s => s.length > 0).join('\n\n')
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
  return queuedResult(plans.filter(p => queue.some(q => q.entry === p.entry)).reduce((n, p) => n + p.messageCount, 0), notes)
}

/** Under the min limit nothing is paraphrased: a range may only be dropped, with a stub for a summary, and may not cover a block,
    whose summary the stub would replace. */
async function assertStubsUnderMin($: Dollar, config: Config, args: CompressArgs, plans: readonly Plan[]) {
  const { context } = await $.session.usage()
  if (context.tokens === undefined || context.tokens >= resolveLimit(config.minContextLimit, context.window)) return
  const merging = plans.filter(p => p.consumedBlockIds.length > 0).map(p => `${p.entry.startId}..${p.entry.endId} covers ${p.consumedBlockIds.map(n => `b${n}`).join(', ')}`)
  if (merging.length > 0) throw new PlanError(`Context is ${formatTokens(context.tokens)}, under the ${config.minContextLimit} limit: ranges must not cover compressed blocks; merge them only over the limit. ${merging.join(', ')}.`)
  const long = args.content.filter(c => c.summary.length > STUB_LIMIT_CHARS).map(c => `${c.startId}..${c.endId} has ${c.summary.length}`)
  if (long.length > 0)
    throw new PlanError(`Context is ${formatTokens(context.tokens)}, under the ${config.minContextLimit} limit: summaries must be stubs of about ${STUB_MAX_CHARS} characters, ${STUB_LIMIT_CHARS} at most (what was dropped and why). ${long.join(', ')}.`)
}

const BUSY_STATUSES: AgentStatus[] = ['pending', 'running', 'waiting']

// the fork moves the old session's folder, which holds the subagents' transcripts: wait until none is working
async function agentsBusy($: Dollar) {
  return (await $.agent.list()).some(a => BUSY_STATUSES.includes(a.status))
}

/** Whether a fork that removes `removed` tokens is worth the cache rewrite it causes: everything from its first change on is written again. */
const paysForRewrite = (config: Config, removed: number, rewritten: number) => removed >= config.minRemovedShare * rewritten

type Draft = { idx: Index; plans: Plan[]; pruned: Set<string>; out: Row[]; scale: number; removed: number; rewritten: number }

/** The transcript as the fork would write it, with what it removes and what it makes the cache rewrite: everything from its first change on. */
function draftFork(rows: readonly Row[], path: string, queued: readonly Queued[], config: Config, to: string): Draft {
  const idx = indexRows(rows)
  const plans = planCompression(rows, idx, { topic: 'queued', content: queued.map(q => q.entry) }, config, outputsDir(path))
  const pruned = markPruned(idx, config)
  const out = applyCompression(applyPrunes(rows, idx, pruned), idx, plans, { sessionId: to, newUuid: () => crypto.randomUUID() })
  const scale = tokensPerChar(rows)
  if (scale === undefined) throw new Error('the conversation has no two consecutive answered requests to measure its tokens per character on')
  const firstChanged = Math.min(...plans.map(p => p.s), ...idx.calls.filter(c => pruned.has(c.id)).map(c => c.useRow), ...staleCopies(rows), ...staleReminders(rows))
  return { idx, plans, pruned, out, scale, removed: tokensOf(rowChars(rows) - rowChars(out), scale), rewritten: tokensOf(rowChars(out.slice(firstChanged)), scale) }
}

/** Whether a fork is worth making now: it removes enough for its cache rewrite, or the context is over the max. Logs why it waits otherwise. */
async function forkPays($: Dollar, config: Config, draft: Draft): Promise<boolean> {
  const { context } = await $.session.usage()
  if (context.tokens === undefined) throw new Error('no request has been answered yet, so the size of the context is unknown')
  if (paysForRewrite(config, draft.removed, draft.rewritten) || context.tokens > maxLimit(config, context.window, draft.idx, draft.scale)) return true
  await log($, `fork waits: it would remove ~${formatTokens(draft.removed)} and make the cache rewrite ~${formatTokens(draft.rewritten)} (minRemovedShare ${config.minRemovedShare})`)

  return false
}

/** Applies the queued compressions and the strategies to a copy of the transcript and switches the session to it; false when the
    fork would cost the cache more than it removes, the compressions then waiting for a larger fork. `forced` skips that check (a
    /dcp-prune, or a turn already stopped for this fork). `current` throws while the transcript has not caught up with the session;
    `then` runs in the fork once the switch is done. The queue is cleared only then: a switch that fails leaves it for the next fork.
    `turns` is the count of turns started when the turn that forks ended: one started since (a scheduled task, a queued prompt)
    writes into the old session, so the fork is dropped, switching back if the resume waited for that turn, and the queue waits
    for its end. */
async function forkQueued($: Dollar, config: Config, state: State, turns: number, current: (rows: Row[], path: string) => void, forced: boolean, then?: (removed: string) => Promise<unknown>): Promise<boolean> {
  if (state.forking) {
    await log($, 'fork waits: an earlier fork has not switched yet')
    return false
  }
  const from = await $.session.id()
  const { rows, path } = await readWhen($, (rows, path) => {
    try {
      current(rows, path)
    } catch (err) {
      throw new LagError((err as Error).message)
    }
    return { rows, path }
  })
  const to = crypto.randomUUID()
  const draft = draftFork(rows, path, await readQueue($, from), config, to)
  if (!forced && !(await forkPays($, config, draft))) return false
  const { idx, plans, pruned, out, removed, rewritten } = draft
  const { context } = await $.session.usage()
  const dir = path.slice(0, path.lastIndexOf('/'))
  const saves = plans.flatMap(p => p.saves)
  if (saves.length > 0) await run($, ['mkdir', '-p', outputsDir(path)])
  for (const { path: file, text } of saves) await $.fs.write(file, text)
  await writeTranscript($, `${dir}/${to}.jsonl`, out)
  transcriptDirs.set(to, dir)
  const gone = idx.calls.filter(c => plans.some(p => c.useRow >= p.s && c.useRow <= p.e) && !isProtected(c.name, c.input, config.protectedTools, config.protectedFilePatterns)).map(c => hashSignature(callSignature(c.name, c.input)))
  const stats = recordFork(await readStats($, from), { before: context.tokens!, estimated: removed, copied: out.length, gone })
  await writeStats($, to, stats)
  const delta = removed >= 0 ? `~${formatTokens(removed)} removed` : `~${formatTokens(-removed)} added`
  const pending = `${delta} (estimated; measured at the next reply)`
  await log($, `forked ${from} -> ${to}: ${plans.length} ranges compressed, ${pruned.size} tool calls pruned, ${pending}, cache rewrite ~${formatTokens(rewritten)}; resuming`)
  const drop = async () => {
    await run($, ['rm', '-f', '--', `${dir}/${to}.jsonl`])
    transcriptDirs.delete(to)
    await $.store.delete(`stats2:${to}`)
    await log($, `fork ${to} dropped: a turn started in ${from} after the fork read it; the queue waits for that turn's end`)
  }
  state.forking = true
  $.clock.after(RESUME_DELAY_MS, async () => {
    try {
      if (state.turns !== turns) return await drop()
      const draftText = (await $.prompt.read()).text
      await $.command.run({ command: 'resume', args: to })
      const id = await $.session.id()
      if (id !== to) throw new Error(`switch to ${to} did not happen; session is ${id}`)
      if (state.turns !== turns) {
        await $.command.run({ command: 'resume', args: from })
        const back = await $.session.id()
        if (back !== from) throw new Error(`switch back to ${from} did not happen; session is ${back}, a fork that lacks the latest turn`)
        return await drop()
      }
      await writeQueue($, from, [])
      if (draftText.length > 0) {
        const { isFilled, refusal } = await $.prompt.fill({ text: draftText })
        if (!isFilled) throw new Error(`could not put the unsent draft back after the switch (${refusal ?? 'refused by a hook'}); it was: ${draftText}`)
      }
      await then?.(delta)
      await archiveSession($, dir, from)
      transcriptDirs.delete(from)
      const deleted = await pruneArchive($, dir, config.archiveDays)
      await run($, ['rm', '-f', '--', await statusFile($, from)])
      await log($, `now in ${id}, forked from ${from}, which is archived (${deleted} older archived session(s) deleted)`)
      await $.ui.toast(`dcp: compressed ${plans.length} range(s), pruned ${pruned.size} tool call(s): ${pending}`)
      await pin($, `${removed >= 0 ? 'compressed' : 'grew'} ~${formatTokens(Math.abs(removed))} (estimate)`)
    } catch (err) {
      await report($, err)
    } finally {
      state.forking = false
    }
  })

  return true
}

/** Whether the turn should stop before its next request so the queued compressions apply now: no subagent works, and the fork pays.
    Judged on the transcript as it stands, which may lag the latest tool results; they weigh little against the ranges. */
async function stopForFork($: Dollar, config: Config, state: State): Promise<boolean> {
  if (state.forking || (await agentsBusy($))) return false
  const { rows, path } = await loadTranscript($)
  if (tokensPerChar(rows) === undefined) {
    await log($, 'turn not stopped for the fork: no two consecutive answered requests to size it by yet; it waits for the turn end')
    return false
  }
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

const statusFile = async ($: Dollar, id: string) => `${await $.env.get('HOME')}/.claude/dcp-status-${id}`

/** Pins the text under the prompt and writes it where the user's statusLine command can read it. */
async function pin($: Dollar, text: string) {
  $.ui.status(text)
  await $.fs.write(await statusFile($, await $.session.id()), text)
}

/** Pins the real context size and the saving measured so far of this session's lineage under the prompt. */
async function showStatus($: Dollar) {
  const { context } = await $.session.usage()
  if (context.tokens === undefined) return
  await pin($, `context ${formatTokens(context.tokens)} / ${formatTokens(context.window)} (${Math.round((context.tokens / context.window) * 100)}%) · saved ${formatTokens(savedTokens(await readStats($, await $.session.id())))} so far`)
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

/** A `-p` or SDK run never uses the compressed session, so it pays no tokens for dcp unless DCP_HEADLESS=1 asks for it. */
async function startSession($: Dollar, state: State, isInteractive: boolean) {
  state.active = isInteractive || (await $.env.get('DCP_HEADLESS')) === '1'
  if (!state.active) return
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
}

export const register: Register = (on, options) => {
  const config = options as unknown as Config
  const state: State = { nextRef: 0, seeded: false, allocating: Promise.resolve(), toolsThisTurn: 0, sinceNudge: Infinity, queuedThisTurn: false, applyPending: false, stopped: false, ran: [], turns: 0, forking: false, pruning: false, ending: false, active: false }

  on('session.start', async ($, e, next) => {
    await startSession($, state, e.isInteractive)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    if (!state.active) return next(e)
    const { sections } = await next(e)

    return { sections: [...sections, { id: 'dcp:system', text: systemPrompt(COMPRESS_TOOL, config.protectedTools), scope: 'session' as const }] }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!state.active || e.command || e.isMeta) return next(e)
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
        if (err instanceof PlanError || err instanceof LagError) return { deny: err.message }
        throw err
      }
    } else result = await next(e)
    if (result.deny !== undefined) return result
    state.ran.push(e.tool_use_id)
    state.toolsThisTurn++
    state.sinceNudge++
    const nudges = await reported($, () => computeNudges($, config, state))

    return { ...result, context: [...(result.context ?? []), ...nudges, tagLine(await nextMessageRef($, state)).trim()] }
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
      // the host refuses a submit from inside this hook, which holds the turn the prompt would wait for
      $.clock.after(RESUME_DELAY_MS, async () => {
        try {
          await $.prompt.submit({ text: prunePrompt(COMPRESS_TOOL, e.args.trim()), asUser: true })
        } catch (err) {
          state.pruning = false
          await report($, err)
        }
      })

      return 'Asked the model to compress closed work.'
    }),
  )

  on('command.run', { command: 'dcp-stats' }, async $ => answer($, async () => renderStats(await readStats($, await $.session.id()))))

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== COMPRESS_TOOL) return next(e)

    return next({ ...e, props: { ...e.props, input: foldCompressInput(e.props.input) } })
  })

  // A block is stored as a user row, so the terminal would draw its whole summary as a message: fold it to one line, all of it on ctrl+o.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const ref = e.props.text.startsWith(COMPRESSED_BLOCK_HEADER) ? trailingRef(e.props.text) : null
    if (e.props.isExpanded || ref === null) return next(e)

    return { type: 'Text', props: { dimColor: true }, children: [`${ref} · compressed conversation section · ${formatTokens(e.props.text.length)} chars (ctrl+o to expand)`] }
  })

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (!state.active || e.stop_hook_active) return result
    const block = await reported($, () => stopReason($, config, state))
    state.ending = block !== undefined

    return block === undefined ? result : { ...result, block }
  })

  // A compression queued mid-turn is applied before the next request: the turn is stopped there, and its end forks, switches and
  // continues the work in the fork with a prompt. The transcript holds the turn's last tool results only once the turn has ended, so
  // the fork waits for that. Without this the context would only shrink when the turn ends, however long it runs.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) state.turns++

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
    if (!state.active || e.agentId !== undefined) return result
    await reported($, () => recordTurnStats($, e.usage))
    await showStatus($)
    if (state.stopped) {
      state.stopped = false
      const ran = state.ran
      await reported($, () => forkQueued($, config, state, turns, (rows, path) => assertAnswered(rows, ran, path), true, async removed => $.prompt.submit({ text: continuePrompt(removed), asUser: true })))
      return result
    }
    if (e.reason !== 'answer') return result
    const forced = state.pruning
    state.pruning = false
    if ((await readQueue($, await $.session.id())).length === 0) return result
    if (await agentsBusy($)) return result
    await reported($, () => forkQueued($, config, state, turns, (rows, path) => assertCurrent(rows, e.answer, path), forced))

    return result
  })
}
