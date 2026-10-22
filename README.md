# claude-dcp

Dynamic context pruning for Claude Code: a reimplementation, with its own code and prompts, of the idea behind [opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) (range mode).

The model gets a `compress` tool. It replaces closed conversation ranges with summaries. Claude Code cannot rewrite a live conversation, so the compression is applied by forking the transcript at the end of the turn and switching the running session to the fork.

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

## What differs from opencode-dynamic-context-pruning

- **Ids:** each `<dcp-message-id>` tag is added as hidden context, after a prompt and after each tool result, so one id names one prompt or one tool output (opencode: one id per message). Prompt text is never edited. Assistant text is untagged.
- **Timing:** `compress` validates and queues; the fork happens when the turn ends. Context shrinks after the turn, not mid-turn. The unsent draft in the prompt box is read before the switch and put back after it.
- **Nudges:** opencode's turn and iteration nudges are replaced by a `classic.Stop` hook (`hooks/stop.ts`): the first stop of a turn is held back once with a prompt by context size. Under `minContextLimit` it asks only to drop dead ranges, and `compress` rejects summaries over 200 characters; from the min it asks to compress and merge the largest chunks; over `maxContextLimit` it asks to be very aggressive. The limit nudge after tool results stays, over the max.
- **Strategies:** deduplication and purge-errors run when a compress is applied.
- **Tool names:** prompts name the registered tool `mcp__dcp__compress`; protected tools default to Claude Code's `Task`, `Agent`, `Skill`, `TodoWrite`.
- **Tokens:** estimated at 4 characters per token for summary and message sizes; context size is the engine's own figure.
- **Log:** `~/.claude/dcp.log`; failures also toast.

## Not implemented

Message mode, manual mode and `/dcp` commands, per-model limits, turn protection, custom prompt overrides, subagent support, compression notifications.
