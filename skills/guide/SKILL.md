---
name: guide
description: Use when working on or troubleshooting the claude-dcp plugin: compress tool, status line, nudges, forks, its code and tests.
---

# dcp guide

Dynamic context pruning. What it is, how it differs from opencode-dynamic-context-pruning, and what is not implemented: `README.md` in the plugin root. Options: `userConfig` in `.claude-plugin/plugin.json`.

## Using it

- The model calls `mcp__dcp__compress` with `topic` and `content: [{ startId, endId, summary }]`. IDs are the `<dcp-message-id>` tags: `mNNNN` for a prompt or one tool output, `bN` for an earlier summary block.
- The call only validates and queues. Before the next request the turn is stopped; at its end the transcript is forked with the ranges replaced, the session switches to the fork, and a plugin prompt continues the work. While a subagent works the queue waits for the turn end. Until the switch the context is unchanged.
- A range removes everything between its two IDs: prompts, assistant text and thinking, tool calls and results, and stale token-count reminders. Skill and tool listings, instructions, environment and the newest copy of each memory file stay (Claude Code supplies them). Only content between tagged IDs can be addressed, so history from before the plugin was loaded cannot.
- Compress closed work only; the tool description says how.
- Feedback: the line under the prompt (`⚠ dcp: …`) shows the real context size and the tokens saved so far, measured from the API's counts; right after a fork it shows `compressed ~X (estimate)` until the first reply. It is also written to `~/.claude/dcp-status-<session id>` for status line scripts, which Claude Code re-runs only on its own events, so such a line can lag one turn. The stats are kept in the shared store per session id (`stats2:<id>`) and carried to each fork. After a switch, a toast states the estimate of what that compression removed.
- `/plugin configure dcp@claude-dcp` changes thresholds. Lower `minContextLimit` / `maxContextLimit` for tighter context.

## Troubleshooting

Start with `~/.claude/dcp.log` (last 200 lines; errors also toast). Then the session transcript: `~/.claude/projects/<cwd with every non-alphanumeric as ->/<session id>.jsonl`. Read it without the request-log rows: `grep -v -e '^{"type":"api-request' <file>`.

| Symptom | Cause and check |
| --- | --- |
| No compress tool | Plugin not enabled (`claude plugin list`), the session predates the install (`/reload-plugins`), or it is headless (`claude -p`, SDK): see Headless in `README.md`. |
| `startId … is not available in the current conversation context` | The ID is not in the transcript: already compressed away, mistyped, or the transcript still lags (retried 10 × 500 ms first). |
| `content[i] (…) overlaps content[j] (…)` / `partly overlaps … queued by an earlier call` | Two ranges of one call share rows, or a range cuts through one queued earlier and not applied yet: cover all of it to replace it, or none. A range inside a queued one is skipped, with a note in the result. |
| Stop never held back | `classic.Stop` skips when `stop_hook_active`, a compress is already queued, no real token figure exists yet, or the context is under the min with no tool result since the prompt. |
| `summaries must be stubs` | Context is under `minContextLimit`; drop with a stub or wait. |
| Compress answered, no fork | The queue is applied at the end of a turn the plugin stopped (`turn.step`) or that ended with an answer; the stop is skipped while a subagent works, before two answered requests exist, or when the fork would not pay (`fork waits` in the log); an aborted turn keeps it, and so does a turn that ends while a subagent is pending, running or waiting (the fork moves the folder holding its transcript). Look for `ERROR` in the log, and for `fork waits:` (the fork would remove too little of what it makes the cache rewrite; it runs once a larger compress is queued or the context passes the max). |
| `does not yet end with the turn's final answer; it lags the session` | The transcript never caught up within the attempts; the fork was skipped and the queue kept for the next turn end. |
| `does not yet hold the results of …; it lags the session` | A stopped turn's transcript never held every tool call the turn ran, with its result, within the attempts; the fork was skipped and the queue kept. |
| `fork X dropped: a turn started in Y after the fork read it` | A turn (scheduled task, queued prompt) started after the turn that forked ended, so its work would be missing from the fork; the fork file is removed, the session switched back if the resume ran after that turn (`switch back to Y did not happen` if that fails), and the queue waits for that turn's end. |
| `fork waits: an earlier fork has not switched yet` | A second fork of the session was asked for while the switch to the first was pending; the queue waits for the next turn end. |
| `switch to X did not happen` | `/resume X` returned but the session id is still the old one; checked right after the call. The fork file still exists. |
| `no transcript found for session X` | No `~/.claude/projects/*/X.jsonl` exists. The transcript is looked up by session id, never from the cwd, because the cwd follows every `cd` the model runs and the transcript stays in the startup directory's folder. |
| `could not read the whole transcript` | `grep` exit status or truncation (4 MiB cap); needs a POSIX `grep`. |
| No status line | No model response yet, so no real token figure (the line appears after the first response, or right after a switch); or a subagent turn. |
| Tags missing | Subagent turns are untagged by design. Otherwise a hook was skipped: the engine prints a dim transcript line and `claude --debug` has the reason. |

A hook that throws is skipped by the engine with a dim transcript line. Only the fork path reports its failures to the log and a toast; elsewhere the dim line is the only trace.

## Changing the code

Module map is in `hooks/`: `register.ts` wires events; `compress.ts` plans ranges and builds block summaries with their kept-verbatim part; `protected.ts` matches protected tools and files; `ids.ts` formats and parses ids; `stats.ts` records turns, forks and repeated calls for `/dcp-stats`; `apply.ts` rewrites rows; `strategies.ts` dedup, purge and stale dcp reminders; `nudges.ts` limits and the block and history reports; `prompts.ts` system prompt, tool description, nudges, compress result and continue prompt; `stop.ts` end-of-turn prompts; `archive.ts` moves, lists, restores and prunes old sessions; `model.ts` finds tags, blocks and tool calls in rows; `transcript.ts` paths and parsing.

- Test first. Everything runs through the engine: `claude plugin test .`; also `claude plugin validate .` and `npx tsc -p .`. `hooks/rows.fixture.ts` builds transcripts; `world.fixture.ts` answers the engine's ops (`fs.*`, `process.run`, `session.*`, `ui.*`, `command.run`) with `on(...)` hooks that return `{ value }`.
- Start every child process through `exec`/`run` in `archive.ts` (cwd `/`): a child inherits the session's cwd otherwise, and fails with `ENOENT posix_spawn` once that directory is gone (a removed worktree).
- Never derive the transcript path from `$.session.cwd()`: it changes with `cd`. A session that moved directories once lost all tagging and nudges silently, because every hook that read the transcript failed and the engine skipped it.
- A helper that takes `$` must be a top-level function: the validator rejects a closure that receives `$`.
- `$.store` is shared by every session on the machine: key per-session values by session id (the compress queue is), and never keep a "pending" marker in it — a stale one from a non-interactive run once made fresh sessions report a switch that never happened.
- Row layout facts the code relies on (verified on 2.1.303, internal and version-dependent): every tag is a `hook_additional_context` attachment row (`hookName` `prompt.submit` after a prompt's user row, `tool.call` after a `tool_result` row, whose `toolUseID` is the call id plus `-context`); only summary blocks carry their tag as the last line of a user row's text; an assistant message may span several rows sharing `message.id`. Re-verify with a `claude -p` run in a scratch directory before changing them.
- Hands-on checks after a change: `DCP_HEADLESS=1 claude -p … --plugin-dir <plugin>` in a scratch directory for the non-interactive path (without the variable dcp is off there), and a tmux-driven `claude --plugin-dir <plugin>` for the interactive switch. Unit tests alone proved insufficient here.
