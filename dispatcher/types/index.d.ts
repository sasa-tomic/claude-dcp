export type DcpDispatch = {
  resume: (args: { sessionId: string }) => Promise<void>
  failure: (args: { sessionId: string }) => Promise<string | null>
}

declare module 'claude-code' {
  interface EngineInterface {
    dcpDispatch: DcpDispatch
  }
}
