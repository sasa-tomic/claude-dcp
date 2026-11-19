import { describe, expect, test } from 'claude-code/testing'

import { AFTER_CALL, continuePrompt, iterationNudge, limitNudge, prunePrompt, queuedResult, systemPrompt, toolDescription } from './prompts'

const TOOL = 'mcp__dcp__compress'

describe('systemPrompt', () => {
  test('names the tool, marks injected tags as metadata, and lists protected tools last', () => {
    const text = systemPrompt(TOOL, ['Task', 'Skill'], true)
    expect(text).toContain(`${TOOL} is your only context tool`)
    expect(text).toContain('COMPRESS a range once')
    expect(text).toContain('DO NOT COMPRESS what the next steps need')
    expect(text).toContain('<dcp-message-id> tags')
    expect(text.endsWith('The outputs of `Task`, `Skill` survive compression; leave them out of summaries.')).toBe(true)
    expect(text).not.toMatch(/\n\n\n/)
  })

  test('steers ranges to start and end at tool outputs, leaving prompts and final answers outside', () => {
    const text = systemPrompt(TOOL, [], false)
    expect(text).toContain("Compression always keeps verbatim: the user's messages (up to 30; past that, list marginal ones in drop), your last 10 text messages, and the answers of the last 2 turns.")
    expect(text).toContain("Never compress a turn's final answer: end each range at a tool-output id.")
  })

  test('says small compressions wait for the fork to pay, and says nothing about subagents', () => {
    const text = systemPrompt(TOOL, [], false)
    expect(text).toContain('Small compressions stay queued until together they are worth the fork that applies them.')
    expect(text).not.toMatch(/subagent/i)
  })

  test('adds no protected-tools paragraph without protected tools', () => {
    expect(systemPrompt(TOOL, [], false)).not.toContain('survive compression')
  })

  test('with memory on, asks to save what later sessions need to memory before each call and to keep only the active tasks', () => {
    const text = systemPrompt(TOOL, [], true)
    expect(text).toContain(`Before every ${TOOL} call, including those reminders ask for, save densely to memory`)
    expect(text).toContain('(see the Memory section)')
    expect(text).toContain('Summaries then keep only what the active tasks need.')
  })

  test('with memory off, asks for no memory writes', () => {
    expect(systemPrompt(TOOL, [], false)).not.toMatch(/memory/i)
  })
})

describe('toolDescription', () => {
  test('carries the id grammar, the block rewrite rule, save and drop, with the tool name', () => {
    const text = toolDescription(TOOL)
    expect(text).toContain('mNNNN for a message and bN for an earlier compressed block')
    expect(text).toContain('your summary replaces theirs')
    expect(text).toContain('save: IDs of tool outputs')
    expect(text).toContain('drop: once the conversation keeps more than 30 user messages')
    expect(text).toContain(`one ${TOOL} call`)
  })
})

describe('limitNudge', () => {
  test('is a system-reminder that names the tool and carries the guidance before the closing tag', () => {
    const text = limitNudge(TOOL, 'G')
    expect(text.startsWith('<dcp-system-reminder>\n')).toBe(true)
    expect(text).toContain(`You MUST call ${TOOL} now`)
    expect(text.endsWith('\n\nG\n</dcp-system-reminder>')).toBe(true)
  })

  test('has no blank guidance slot when there is no guidance', () => {
    expect(limitNudge(TOOL, '')).not.toContain('\n\n')
  })
})

describe('iterationNudge', () => {
  test('is a system-reminder naming the tool, with the guidance', () => {
    const text = iterationNudge(TOOL, 'G')
    expect(text).toContain(`call ${TOOL} on it now`)
    expect(text.endsWith('\n\nG\n</dcp-system-reminder>')).toBe(true)
  })
})

describe('queuedResult', () => {
  test('counts the messages, says when they leave, and lists the notes', () => {
    expect(queuedResult(1, ['a skipped'], false)).toMatch(/^Queued 1 message for compression\. .*before your next step.*\na skipped$/s)
    expect(queuedResult(2, [], false)).toMatch(/^Queued 2 messages /)
  })

  test('with subagents busy, says the compression waits for them and how to end them', () => {
    expect(queuedResult(1, [], true).endsWith('\nA queued compression cannot execute until all subagents finish. Do not start new subagents; use SendMessage to ask the running ones to wrap up, or TaskStop those you no longer need. After that, use subagents as usual.')).toBe(true)
    expect(queuedResult(1, [], false)).not.toMatch(/subagent/i)
  })
})

describe('continuePrompt', () => {
  test('is a short reminder that says what was removed', () => {
    expect(continuePrompt('~5.0k removed')).toBe('<dcp-system-reminder>\nCompressions applied (~5.0k removed). Continue the task.\n</dcp-system-reminder>')
  })
})

describe('prunePrompt', () => {
  test('asks for one dense compress call and a one-word answer, naming the tool', () => {
    const text = prunePrompt(TOOL, '')
    expect(text).toContain(`one ${TOOL} call`)
    expect(text).toContain('dense summaries')
    expect(text.endsWith(`${AFTER_CALL}\n</dcp-system-reminder>`)).toBe(true)
    expect(text).not.toContain('Focus')
  })

  test('puts the hint in before the closing instruction', () => {
    expect(prunePrompt(TOOL, 'the audit work')).toContain('Focus: the audit work\nWrite no text before the call;')
  })
})
