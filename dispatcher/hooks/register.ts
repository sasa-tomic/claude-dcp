import type { Register } from 'claude-code'
import type { DcpDispatch } from '../types'

export const register: Register = on => {
  on('engine.create', async (_$, e, next) => {
    const beneath = await next(e)
    const failures = new Map<string, string>()
    const dcpDispatch: DcpDispatch = {
      resume: async ({ sessionId }) => {
        beneath.clock.after(0, async () => {
          try {
            await beneath.command.run({ command: 'resume', args: sessionId })
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            failures.set(sessionId, message)
            beneath.ui.toast(`dcp dispatch to ${sessionId} failed: ${message}`)
          }
        })
      },
      failure: async ({ sessionId }) => {
        const message = failures.get(sessionId) ?? null
        failures.delete(sessionId)
        return message
      },
    }
    return { ...beneath, dcpDispatch }
  })
}
