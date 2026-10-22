import { describe, expect, test } from 'claude-code/testing'

import { limitNudge, systemPrompt, toolDescription } from './prompts'

const TOOL = 'mcp__dcp__compress'

describe('systemPrompt', () => {
  test('names the tool, marks injected tags as metadata, and lists protected tools last', () => {
    const text = systemPrompt(TOOL, ['Task', 'Skill'])
    expect(text).toContain(`${TOOL} is your only context tool`)
    expect(text).toContain('<dcp-message-id> tags')
    expect(text.endsWith('The environment keeps the outputs of `Task`, `Skill` through compression. Leave them out of summaries.')).toBe(true)
    expect(text).not.toMatch(/\n\n\n/)
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
    expect(text).toContain(`Call ${TOOL} now.`)
    expect(text.endsWith('\n\nG\n</dcp-system-reminder>')).toBe(true)
  })

  test('has no blank guidance slot when there is no guidance', () => {
    expect(limitNudge(TOOL, '')).not.toContain('\n\n')
  })
})
