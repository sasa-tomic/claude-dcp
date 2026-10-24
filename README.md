# claude-dcp

Dynamic context pruning for Claude Code: a reimplementation, with its own code and prompts, of the idea behind [opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) (range mode).

The model gets a `compress` tool. It replaces closed conversation ranges with summaries. Claude Code cannot rewrite a live conversation, so the compression is applied by forking the transcript at the end of the turn (once no subagent is working) and switching the running session to the fork.

## Why prune continuously

Compaction, as Anthropic [defines it](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), summarizes a conversation that is nearing the context window limit. By then the model is working with a full context, and the summary is written in one pass over everything. This plugin prunes at the end of every turn, so the context stays small the whole session. Dead ranges (finished work, superseded file reads, failed attempts) become a short stub, and only what is still needed gets a dense summary.

- **Accuracy.** Every study below finds that models get worse as the input grows, even on simple retrieval. Chroma's [Context Rot](https://research.trychroma.com/context-rot) (18 LLMs) finds performance degrades with input length in every experiment, and that distractors (text on a related topic that does not answer the question) make it worse. Stale tool output and abandoned approaches are exactly such distractors. [NoLiMa](https://arxiv.org/abs/2502.05167) (13 LLMs claiming at least 128K tokens): at 32K tokens, 11 models fall below 50% of their short-context baseline; GPT-4o drops from 99.3% to 69.7%. [RULER](https://arxiv.org/abs/2404.06654) (17 LLMs claiming at least 32K): only about half hold up at 32K. [Lost in the Middle](https://arxiv.org/abs/2307.03172) finds information in the middle of a long context is used worst. Anthropic names the same effect "context rot" and says to treat context as a finite resource ([Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- **Cost.** Every turn re-sends the whole conversation, so the cost of a turn grows with its size. With [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) a cache read costs 0.1x the base input price (0.05x on Sonnet 5.5 and Opus 5.5) and a 5-minute cache write 1.25x. Halving the context from 200k to 100k halves the cache-read cost of every later turn. The fork rewrites the cache once: at 0.1x reads, that costs about as much as 10 turns of the saving, then it is net positive (about 23 turns at 0.05x). Pruning pays off in long sessions, not in short ones. Anthropic reports, for its own context-editing feature on an internal agentic-search eval, 29% better results and, in a 100-turn web-search eval, 84% fewer tokens ([Managing context](https://www.anthropic.com/news/context-management)).
- **Headroom.** A session that stays small never reaches the limit, so there is no forced compaction in the middle of a task, and each summary is written while the details are still fresh.

None of these numbers measure this plugin. The studies test retrieval benchmarks and other models, and Anthropic's figures are for a different mechanism. The cost break-even is arithmetic from the published price multipliers, and assumes the fork misses the cache entirely.

## Install

```
/plugin install dcp --marketplace sasa-tomic/claude-dcp
```

Needs Claude Code 2.1.287 or later (mods). The `prompt.compose` hook does not run in a plugin that a person installs where an organization manages Claude Code.

## Configure

Every option is optional; the defaults suit most sessions. Review and change them with `/plugin configure dcp@claude-dcp`.

## Update

```
/plugin marketplace update claude-dcp
```

Then `/plugin`, Installed tab, dcp, Update now, then `/reload-plugins`.

## Remove

```
/plugin uninstall dcp
/plugin marketplace remove claude-dcp
/reload-plugins
```

## Pruning on demand

`/dcp-prune [hint]` asks the model to compress the largest closed chunks now, with dense summaries; the hint says where to focus (`/dcp-prune the audit work`). That one compress is not held to the stub rule under `minContextLimit`, and its fork ignores `minRemovedShare`. The fork still happens when the turn ends.

## Old sessions

Each fork moves the session it replaces into `archive/` of the project folder, where `/resume` does not list it. `/dcp-archive` lists the archived ones, `/dcp-restore <id>` moves one back. Archived sessions older than `archiveDays` are deleted at the next fork.

## Measuring

`/dcp-stats` reads figures the plugin records at each turn end, across forks. It reports the context per segment between forks, the tokens each fork removed, the cache write each fork forced, the tokens billed by kind, and the calls that repeated one compressed away. That last figure is a proxy for lost information, not a measure of accuracy.

What a fork removed is measured, not estimated: the context of the last request before the fork minus the context of the first request after it, both as the API counted them. It reads slightly low, since that first request also holds your next prompt. The engine keeps reporting the old session's figures until that request, so until then the fork shows only its estimate, and the end-of-turn prompts and limit nudges stay silent.

Sizes in the nudge lists, the summary buffer and the fork decision are estimates. They use the tokens per character of this conversation, measured on the API's counts: from one request to the next, the input grows by what the answer and the rows after it weigh. Code and JSON take more tokens per character than prose, so no fixed rate is assumed. In one hands-on run the estimate of a fork was 13.0k and the measurement 12.0k.

A fork rewrites the prompt cache from its first change on, so a saving in context is not a saving in cost until enough turns follow; the per-segment lines show both sides.

## What differs from opencode-dynamic-context-pruning

- **Ids:** each `<dcp-message-id>` tag is added as hidden context, after a prompt and after each tool result, so one id names one prompt or one tool output (opencode: one id per message). Prompt text is never edited. Assistant text is untagged.
- **Timing:** `compress` validates and queues; the fork happens when the turn ends. Context shrinks after the turn, not mid-turn. A fork that would remove less than `minRemovedShare` of what it makes the cache rewrite waits for a larger one, unless the context is over the max. The unsent draft in the prompt box is read before the switch and put back after it.
- **Nudges:** opencode's turn and iteration nudges are replaced by a `classic.Stop` hook (`hooks/stop.ts`): the first stop of a turn is held back once with a prompt by context size. Under `minContextLimit` it asks only to drop dead ranges, and `compress` rejects summaries over 200 characters; from the min it asks to compress and merge the largest chunks; over `maxContextLimit` it asks to be very aggressive. The limit nudge after tool results stays, over the max.
- **Headless:** a `claude -p` or SDK run never uses the compressed session, so dcp stays off in it (no tool, prompt, tags or stop hook) unless `DCP_HEADLESS=1` is set.
- **Strategies:** deduplication and purge-errors run when a compress is applied.
- **Tool names:** prompts name the registered tool `mcp__dcp__compress`; protected tools default to Claude Code's `Task`, `Agent`, `Skill`, `TodoWrite`.
- **Tokens:** context size and the tokens a fork removed are the API's counts; sizes of summaries and messages are estimates (see Measuring).
- **Log:** `~/.claude/dcp.log`; failures also toast.

## Not implemented

Message mode, manual mode and `/dcp` commands, per-model limits, turn protection, custom prompt overrides, subagent support, compression notifications.
