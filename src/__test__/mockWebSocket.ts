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

  url: string

  constructor(url: string) {
    this.url = url
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({code, reason, readyStateAtCall: this.readyState})
    this.readyState = this.CLOSING
  }

  addEventListener(): void {
    // required by rxjs' `fromEvent`; message events are not exercised in tests
  }

  removeEventListener(): void {
    // required by rxjs' `fromEvent`
  }

  // -- test controls --

  finishHandshake(): void {
    this.readyState = this.OPEN
    this.onopen?.()
  }

  disconnect(code: number, reason: string): void {
    this.readyState = this.CLOSED
    this.onclose?.({code, reason})
  }

  emitError(): void {
    this.onerror?.()
  }
}
