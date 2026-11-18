import { expect, mock, test } from 'claude-code/testing'
import type {} from '../dispatcher/types'
import { register } from '../dispatcher/hooks/register'

const dispatcher = { name: 'dcp-dispatcher', register }
const caller = { name: 'dispatch-caller', register(on: import('claude-code').On) {
  on('prompt.submit', async ($, e, next) => {
    if (e.text === 'status') {
      const failure = await $.dcpDispatch.failure({ sessionId: 'target' })
      $.ui.toast(`dispatch failure: ${failure}`)
    } else await $.dcpDispatch.resume({ sessionId: 'target' })
    return next(e)
  })
  on('command.run', { command: 'resume' }, (_$, e, next) => next({ ...e, args: `${e.args}-received` }))
} }

test('queues resume through the calling plugin without holding the caller open', { plugins: [dispatcher, caller] }, async ($, on) => {
  const clock = mock.clock(on)
  const targets: string[] = []
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('command.run', (_$, e) => { targets.push(e.args); return {} })
  on('session.id', () => ({ value: 'target' }))
  await $.prompt.submit({ text: 'queue test', wait: false, isMeta: true, origin: { kind: 'composer' } })
  expect(targets).toEqual([])
  await clock.advance(1)
  expect(targets).toEqual(['target-received'])
})

test('reports a dispatch failure after the scheduling call has returned', { plugins: [dispatcher, caller] }, async ($, on) => {
  const clock = mock.clock(on)
  const notices: string[] = []
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.toast', (_$, e) => { notices.push(e.text); return { value: undefined } })
  await $.prompt.submit({ text: 'queue test', wait: false, isMeta: true, origin: { kind: 'composer' } })
  await clock.advance(1)
  expect(notices).toEqual(['dcp dispatch to target failed: no implementation for command.run'])
  await $.prompt.submit({ text: 'status', wait: false, isMeta: true, origin: { kind: 'composer' } })
  expect(notices.at(-1)).toBe('dispatch failure: no implementation for command.run')
  await $.prompt.submit({ text: 'status', wait: false, isMeta: true, origin: { kind: 'composer' } })
  expect(notices.at(-1)).toBe('dispatch failure: null')
})
