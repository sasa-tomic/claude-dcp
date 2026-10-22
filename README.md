# claude-dcp

Dynamic context pruning for Claude Code: a reimplementation, with its own code and prompts, of the idea behind [opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) (range mode).

The model gets a `compress` tool. It replaces closed conversation ranges with summaries. Claude Code cannot rewrite a live conversation, so the compression is applied by forking the transcript at the end of the turn and switching the running session to the fork.

## Install

```
/plugin install dcp --marketplace sasa-tomic/claude-dcp
```

Needs Claude Code 2.1.287 or later (mods). The `prompt.compose` hook does not run in a plugin that a person installs where an organization manages Claude Code.

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

## Options

See `userConfig` in `.claude-plugin/plugin.json`.
