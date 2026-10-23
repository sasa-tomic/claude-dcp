import type { AgentStatus, Hook, Register } from 'claude-code'

import { applyCompression } from './apply'
import { archiveSession, listArchive, pruneArchive, restoreSession, run } from './archive'
import { type CompressArgs, type CompressConfig, type Plan, PlanError, UNKNOWN_ID, assertDisjoint, planCompression } from './compress'
import { messageRef, tagLine } from './ids'
import { COMPRESSED_BLOCK_HEADER, type Index, indexRows } from './model'
import { limitNudge, systemPrompt, toolDescription } from './prompts'
import { answeredRequests, blockReport, formatTokens, messageReport, resolveLimit, rowChars, tokensOf, tokensPerChar } from './nudges'
import { isProtected } from './protected'
import { foldCompressInput, STUB_MAX_CHARS, stopPrompt, stopTier } from './stop'
import { applyPrunes, callSignature, markPruned, type StrategyConfig } from './strategies'
import { emptyStats, hashSignature, isAwaitingFirst, recordCall, recordFirstRequest, recordFork, recordTurn, renderStats, savedTokens, type Stats, type TurnUsage } from './stats'
import { assertCurrent, parseTranscript, serializeTranscript } from './transcript'
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
type Queued = { args: CompressArgs; plans: Pick<Plan, 'index' | 'entry' | 's' | 'e'>[] }

const TOOL_NAME = 'compress'
const FULL_TOOL_NAME = 'mcp__dcp__compress'
const LOG_LINES = 200
const READ_ATTEMPTS = 10
const READ_INTERVAL_MS = 500
const RESUME_DELAY_MS = 1000

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
async function readQueue($: Dollar): Promise<Queued[]> {
  return ((await $.store.get(`queue:${await $.session.id()}`)) as Queued[] | undefined) ?? []
}

async function writeQueue($: Dollar, queue: Queued[]) {
  await $.store.set(`queue:${await $.session.id()}`, queue)
}

async function readStats($: Dollar, id: string): Promise<Stats> {
  return ((await $.store.get(`stats:${id}`)) as Stats | undefined) ?? emptyStats()
}

async function writeStats($: Dollar, id: string, stats: Stats) {
  await $.store.set(`stats:${id}`, stats)
}

// A session's transcript lives in the project folder of the directory it started in, while the session's cwd moves with
// every `cd` the model runs; so the transcript is found by session id, never derived from the cwd.
const transcriptDirs = new Map<string, string>()

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
  const child = $.process.spawn({ argv: ['grep', '-v', '-e', '^{"type":"api-request', path] })
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
  const { exitCode, stderr } = await $.process.run(['dd', `of=${path}`, 'status=none'], { stdin: serializeTranscript(rows), timeoutMs: 120_000 })
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

type State = { nextRef: number; toolsSincePrompt: number; sinceLimitNudge: number; queuedThisTurn: boolean }

const resetNudges = (state: State) => Object.assign(state, { toolsSincePrompt: 0, sinceLimitNudge: Infinity })

async function guidance(idx: Index, rows: readonly Row[], scale: number) {
  return [blockReport(idx.blocks, scale), messageReport(rows, idx, scale)].filter(s => s.length > 0).join('\n\n')
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

/** The limit nudge after a tool result, when the context is over the max and enough results passed since the last one; empty otherwise. */
async function computeNudges($: Dollar, config: Config, state: State): Promise<string[]> {
  const { context } = await $.session.usage()
  if (context.tokens === undefined || context.tokens < resolveLimit(config.minContextLimit, context.window)) return []
  if (state.sinceLimitNudge < config.nudgeFrequency || (await figuresStale($))) return []
  const { rows } = await loadTranscript($)
  const idx = indexRows(rows)
  const scale = tokensPerChar(rows)
  if (scale === undefined || context.tokens <= maxLimit(config, context.window, idx, scale)) return []
  state.sinceLimitNudge = 0

  return [limitNudge(FULL_TOOL_NAME, await guidance(idx, rows, scale))]
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
  if (context.tokens < min && state.toolsSincePrompt === 0) return undefined
  const { rows } = await loadTranscript($)
  const idx = indexRows(rows)
  const scale = tokensPerChar(rows)
  if (scale === undefined) return undefined
  const tier = stopTier(context.tokens, min, maxLimit(config, context.window, idx, scale))
  const advice = tier === 'drop' ? messageReport(rows, idx, scale) : await guidance(idx, rows, scale)

  return [stopPrompt(tier, FULL_TOOL_NAME), advice].filter(part => part.length > 0).join('\n\n')
}

/** Validates the call against the transcript and queues it for the fork at the end of the turn. */
async function queueCompress($: Dollar, config: Config, state: State, args: CompressArgs): Promise<string> {
  const queued = await readQueue($)
  const plans = await readWhen($, rows => {
    try {
      return planCompression(rows, indexRows(rows), args, config)
    } catch (err) {
      throw err instanceof PlanError && err.message.includes(UNKNOWN_ID) ? new LagError(err.message) : err
    }
  })
  await assertStubsUnderMin($, config, args)
  assertDisjoint([...queued.flatMap(q => q.plans), ...plans.map(p => ({ ...p, index: queued.length + p.index }))])
  await writeQueue($, [...queued, { args, plans: plans.map(({ index, entry, s, e }) => ({ index, entry, s, e })) }])
  resetNudges(state)
  state.queuedThisTurn = true
  return `Compressed ${plans.reduce((n, p) => n + p.messageCount, 0)} messages into ${COMPRESSED_BLOCK_HEADER}.`
}

/** Under the min limit nothing is paraphrased: a range may only be dropped, with a stub for a summary. */
async function assertStubsUnderMin($: Dollar, config: Config, args: CompressArgs) {
  const { context } = await $.session.usage()
  if (context.tokens === undefined || context.tokens >= resolveLimit(config.minContextLimit, context.window)) return
  const long = args.content.filter(c => c.summary.length > STUB_MAX_CHARS).map(c => `${c.startId}..${c.endId} has ${c.summary.length}`)
  if (long.length > 0)
    throw new PlanError(`Context is ${formatTokens(context.tokens)}, under the ${config.minContextLimit} limit: summaries must be stubs of at most ${STUB_MAX_CHARS} characters (what was dropped and why). ${long.join(', ')}.`)
}

/** Applies the queued compressions and the strategies to a copy of the transcript and switches the session to it. */
const BUSY_STATUSES: AgentStatus[] = ['pending', 'running', 'waiting']

// the fork moves the old session's folder, which holds the subagents' transcripts: wait until none is working
async function agentsBusy($: Dollar) {
  return (await $.agent.list()).some(a => BUSY_STATUSES.includes(a.status))
}

/** Whether a fork that removes `removed` tokens is worth the cache rewrite it causes: everything from its first change on is written again. */
const paysForRewrite = (config: Config, removed: number, rewritten: number) => removed >= config.minRemovedShare * rewritten

/** Applies the queued compressions and the strategies to a copy of the transcript and switches the session to it; false when the
    fork would cost the cache more than it removes, the compressions then waiting for a larger fork. */
async function forkQueued($: Dollar, config: Config, answer: string): Promise<boolean> {
  const queued = await readQueue($)
  const from = await $.session.id()
  const { rows, path } = await readWhen($, (rows, path) => {
    try {
      assertCurrent(rows, answer, path)
    } catch (err) {
      throw new LagError((err as Error).message)
    }
    return { rows, path }
  })
  const idx = indexRows(rows)
  const plans = queued.flatMap(q => planCompression(rows, idx, q.args, config))
  assertDisjoint(plans)
  const pruned = markPruned(idx, config)
  const to = crypto.randomUUID()
  const out = applyCompression(applyPrunes(rows, idx, pruned), idx, plans, { sessionId: to, newUuid: () => crypto.randomUUID() })
  const { context } = await $.session.usage()
  if (context.tokens === undefined) throw new Error('no request has been answered yet, so the size of the context is unknown')
  const scale = tokensPerChar(rows)
  if (scale === undefined) throw new Error('the conversation has no two consecutive answered requests to measure its tokens per character on')
  const removed = tokensOf(rowChars(rows) - rowChars(out), scale)
  const firstChanged = Math.min(...plans.map(p => p.s), ...idx.calls.filter(c => pruned.has(c.id)).map(c => c.useRow))
  const rewritten = tokensOf(rowChars(out.slice(firstChanged)), scale)
  if (!paysForRewrite(config, removed, rewritten) && context.tokens <= maxLimit(config, context.window, idx, scale)) {
    await log($, `fork waits: it would remove ~${formatTokens(removed)} and make the cache rewrite ~${formatTokens(rewritten)} (minRemovedShare ${config.minRemovedShare})`)

    return false
  }
  await writeQueue($, [])
  const dir = path.slice(0, path.lastIndexOf('/'))
  await writeTranscript($, `${dir}/${to}.jsonl`, out)
  transcriptDirs.set(to, dir)
  const gone = idx.calls.filter(c => plans.some(p => c.useRow >= p.s && c.useRow <= p.e) && !isProtected(c.name, c.input, config.protectedTools, config.protectedFilePatterns)).map(c => hashSignature(callSignature(c.name, c.input)))
  const stats = recordFork(await readStats($, from), { before: context.tokens, estimated: removed, copied: out.length, gone })
  await writeStats($, to, stats)
  const delta = removed >= 0 ? `~${formatTokens(removed)} removed` : `~${formatTokens(-removed)} added`
  const pending = `${delta} (estimated; measured at the next reply)`
  await log($, `forked ${from} -> ${to}: ${plans.length} ranges compressed, ${pruned.size} tool calls pruned, ${pending}, cache rewrite ~${formatTokens(rewritten)}; resuming`)
  $.clock.after(RESUME_DELAY_MS, async () => {
    try {
      const draft = (await $.prompt.read()).text
      await $.command.run({ command: 'resume', args: to })
      const id = await $.session.id()
      if (id !== to) throw new Error(`switch to ${to} did not happen; session is ${id}`)
      if (draft.length > 0) {
        const { isFilled, refusal } = await $.prompt.fill({ text: draft })
        if (!isFilled) throw new Error(`could not put the unsent draft back after the switch (${refusal ?? 'refused by a hook'}); it was: ${draft}`)
      }
      await archiveSession($, dir, from)
      transcriptDirs.delete(from)
      const deleted = await pruneArchive($, dir, config.archiveDays)
      await run($, ['rm', '-f', '--', await statusFile($, from)])
      await log($, `now in ${id}, forked from ${from}, which is archived (${deleted} older archived session(s) deleted)`)
      await $.ui.toast(`dcp: compressed ${plans.length} range(s), pruned ${pruned.size} tool call(s): ${pending}`)
      await pin($, `compressed: ${pending} · saved ${formatTokens(savedTokens(stats))} so far`)
    } catch (err) {
      await report($, err)
    }
  })

  return true
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

async function startSession($: Dollar, state: State) {
  resetNudges(state)
  await $.command.register({ name: 'dcp-archive', description: 'List sessions dcp archived after compressing' })
  await $.command.register({ name: 'dcp-restore', description: 'Restore an archived session for /resume', argumentHint: '<session id>' })
  await $.command.register({ name: 'dcp-stats', description: 'Show tokens dcp removed and the cache rewrites it caused' })
  await $.tool.register({
    name: TOOL_NAME,
    description: toolDescription(FULL_TOOL_NAME),
    inputSchema: INPUT_SCHEMA,
    isDeferred: false,
  })
  const path = await findTranscript($, await $.session.id())
  state.nextRef = Math.max(state.nextRef, path ? indexRows(await readTranscript($, path)).maxMessageRef : 0)
}

export const register: Register = (on, options) => {
  const config = options as unknown as Config
  const state: State = { nextRef: 0, toolsSincePrompt: 0, sinceLimitNudge: Infinity, queuedThisTurn: false }

  on('session.start', async ($, e, next) => {
    await startSession($, state)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)

    return { sections: [...sections, { id: 'dcp:system', text: systemPrompt(FULL_TOOL_NAME, config.protectedTools), scope: 'session' as const }] }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    resetNudges(state)
    state.queuedThisTurn = false

    return next({ ...e, context: [...(e.context ?? []), tagLine(messageRef(++state.nextRef)).trim()] })
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return e.tool === FULL_TOOL_NAME ? { deny: `${FULL_TOOL_NAME} is for the main conversation only; a subagent's messages carry no ids.` } : next(e)
    let result
    if (e.tool !== FULL_TOOL_NAME) await noteCall($, e.tool, e)
    if (e.tool === FULL_TOOL_NAME) {
      try {
        result = { result: await queueCompress($, config, state, e as unknown as CompressArgs) }
      } catch (err) {
        if (err instanceof PlanError || err instanceof LagError) return { deny: err.message }
        throw err
      }
    } else result = await next(e)
    if (result.deny !== undefined) return result
    state.toolsSincePrompt++
    state.sinceLimitNudge++
    const nudges = await reported($, () => computeNudges($, config, state))

    return { ...result, context: [...(result.context ?? []), ...nudges, tagLine(messageRef(++state.nextRef)).trim()] }
  })

  on('command.run', { command: 'dcp-archive' }, async $ => answer($, async () => listArchive($, await projectDir($))))

  on('command.run', { command: 'dcp-restore' }, async ($, e) =>
    answer($, async () => {
      const id = e.args.trim()
      await restoreSession($, await projectDir($), id)

      return `Restored ${id}. Open it with /resume.`
    }),
  )

  on('command.run', { command: 'dcp-stats' }, async $ => answer($, async () => renderStats(await readStats($, await $.session.id()))))

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== FULL_TOOL_NAME) return next(e)

    return next({ ...e, props: { ...e.props, input: foldCompressInput(e.props.input) } })
  })

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (e.stop_hook_active) return result
    const block = await reported($, () => stopReason($, config, state))

    return block === undefined ? result : { ...result, block }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    await reported($, () => recordTurnStats($, e.usage))
    await showStatus($)
    if (e.reason !== 'answer') return result
    if ((await readQueue($)).length === 0) return result
    if (await agentsBusy($)) return result
    try {
      await forkQueued($, config, e.answer)
    } catch (err) {
      await report($, err)
      throw err
    }

    return result
  })
}
