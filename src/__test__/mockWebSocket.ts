/**
 * Scriptable stand-in for the browser's `WebSocket`. Records every `close()`
 * call with the `readyState` at that moment — closing while still CONNECTING
 * is the "WebSocket is closed before the connection is established" bug.
 */
export class MockWebSocket {
  CONNECTING = 0 as const
  OPEN = 1 as const
  CLOSING = 2 as const
  CLOSED = 3 as const

  readyState: number = this.CONNECTING
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: {code: number; reason: string}) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null

  closeCalls: {
    code: number | undefined
    reason: string | undefined
    readyStateAtCall: number
  }[] = []

  /** Every `send()` call with the `readyState` at that moment. */
  sendCalls: {data: string; readyStateAtCall: number}[] = []

  url: string

  private listeners = new Map<string, Set<(event: any) => void>>()

  constructor(url: string) {
    this.url = url
  }

  // Like the browser, `close()` only starts the closing handshake. Call
  // `finishClose()` to complete it.
  close(code?: number, reason?: string): void {
    this.closeCalls.push({code, reason, readyStateAtCall: this.readyState})
    this.readyState = this.CLOSING
  }

  // Like the browser, a send on a CLOSING or CLOSED socket doesn't throw
  send(data: string): void {
    this.sendCalls.push({data, readyStateAtCall: this.readyState})
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    let listeners = this.listeners.get(type)
    if (!listeners) this.listeners.set(type, (listeners = new Set()))
    listeners.add(listener)
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  private dispatch(type: string, event: unknown): void {
    // Copied, since a listener can remove itself while the loop runs
    for (const listener of Array.from(this.listeners.get(type) ?? [])) listener(event)
  }

  // Like the browser, drops messages that arrive once the socket isn't open
  private deliver(data: string): void {
    if (this.readyState === this.OPEN) this.dispatch('message', {data})
  }

  // -- test controls --

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }

  finishHandshake(): void {
    this.readyState = this.OPEN
    this.onopen?.()
  }

  // Like the browser, fires `onclose` first, then the `close` listeners
  disconnect(code: number, reason: string): void {
    this.readyState = this.CLOSED
    this.onclose?.({code, reason})
    this.dispatch('close', {code, reason})
  }

  /** Completes the closing handshake that `close()` started. */
  finishClose(): void {
    const last = this.closeCalls.at(-1)
    if (!last) throw new Error('close() was not called')
    this.disconnect(last.code ?? 1005, last.reason ?? '')
  }

  emitError(): void {
    this.onerror?.()
  }

  /** Delivers a raw message, as the server sent it. */
  receive(data: string): void {
    this.deliver(data)
  }

  /** Replies to the most recent request for `method` with `result`. */
  respond(method: string, result: unknown): void {
    const request = this.sendCalls
      .map(({data}) => JSON.parse(data) as {id: string; method: string})
      .findLast((req) => req.method === method)
    if (!request) throw new Error(`No ${method} request was sent`)
    this.deliver(JSON.stringify({jsonrpc: '2.0', id: request.id, result}))
  }
}
