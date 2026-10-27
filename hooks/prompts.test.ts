import { describe, expect, test } from 'claude-code/testing'

import { AFTER_CALL, continuePrompt, iterationNudge, limitNudge, prunePrompt, queuedResult, systemPrompt, toolDescription } from './prompts'

const TOOL = 'mcp__dcp__compress'

describe('systemPrompt', () => {
  test('names the tool, marks injected tags as metadata, and lists protected tools last', () => {
    const text = systemPrompt(TOOL, ['Task', 'Skill'])
    expect(text).toContain(`${TOOL} is your only context tool`)
    expect(text).toContain('COMPRESS a range once')
    expect(text).toContain('DO NOT COMPRESS:')
    expect(text).toContain('<dcp-message-id> tags')
    expect(text.endsWith('The environment keeps the outputs of `Task`, `Skill` through compression. Leave them out of summaries.')).toBe(true)
    expect(text).not.toMatch(/\n\n\n/)
  })

  test('steers ranges to start and end at tool outputs, leaving prompts and final answers outside', () => {
    const text = systemPrompt(TOOL, [])
    expect(text).toContain('Never compress user prompts or the final answer of a turn')
    expect(text).toContain('start and end each range at tool-output ids')
  })

  test('adds no protected-tools paragraph without protected tools', () => {
    expect(systemPrompt(TOOL, [])).not.toContain('The environment keeps')
  })
})

describe('toolDescription', () => {
  test('carries the id grammar and the placeholder rule, with the tool name', () => {
    const text = toolDescription(TOOL)
    expect(text).toContain('mNNNN for a message and bN for an earlier compressed block')
    expect(text).toContain('write (bN) in your summary')
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
    expect(queuedResult(1, ['a skipped'])).toMatch(/^Queued 1 message for compression\. .*before your next step.*\na skipped$/s)
    expect(queuedResult(2, [])).toMatch(/^Queued 2 messages /)
  })
})

describe('continuePrompt', () => {
  test('is a reminder, not a user message, that says what was removed', () => {
    expect(continuePrompt('~5.0k removed')).toBe(
      '<dcp-system-reminder>Your compressions were applied (~5.0k removed) and the session continues in a fork. This is not a user message: continue the task where you left off.</dcp-system-reminder>',
    )
  })
})

describe('prunePrompt', () => {
  test('asks for one dense compress call and a one-word answer, naming the tool', () => {
    const text = prunePrompt(TOOL, '')
    expect(text).toContain(`one ${TOOL} call`)
    expect(text).toContain('Dense summaries')
    expect(text.endsWith(AFTER_CALL)).toBe(true)
    expect(text).not.toContain('Focus')
  })

  test('puts the hint in before the closing instruction', () => {
    expect(prunePrompt(TOOL, 'the audit work')).toContain('Focus: the audit work Write no text before the call;')
  })
})
