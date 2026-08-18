import {describe, expect, it} from 'vitest'

import {createConnect, WebSocketError} from '../createConnect'
import {MockWebSocket} from './mockWebSocket'

const GRACEFUL_CLOSE = {
  code: 1000,
  reason: 'WebSockets connection closed by client',
}

const setup = () => {
  const sockets: MockWebSocket[] = []
  const connect = createConnect((url: string) => {
    const ws = new MockWebSocket(url)
    sockets.push(ws)
    return ws
  })
  return {sockets, conn$: connect('wss://mock')}
}

describe('createConnect', () => {
  it('emits the connection once the handshake completes', () => {
    const {sockets, conn$} = setup()
    const received: MockWebSocket[] = []
    const subscription = conn$.subscribe((ws) => received.push(ws))

    expect(sockets).toHaveLength(1)
    expect(received).toHaveLength(0)

    sockets[0]!.finishHandshake()
    expect(received).toEqual([sockets[0]])

    subscription.unsubscribe()
  })

  it('closes the connection gracefully upon unsubscribe once open', () => {
    const {sockets, conn$} = setup()
    const subscription = conn$.subscribe()
    sockets[0]!.finishHandshake()

    subscription.unsubscribe()
    expect(sockets[0]!.closeCalls).toEqual([
      {...GRACEFUL_CLOSE, readyStateAtCall: sockets[0]!.OPEN},
    ])
  })

  it('never closes a socket mid-handshake: unsubscribing while connecting defers the close until open', () => {
    const {sockets, conn$} = setup()
    conn$.subscribe().unsubscribe()

    // The regression under test: this used to close the CONNECTING socket
    // immediately, making browsers warn "WebSocket is closed before the
    // connection is established".
    expect(sockets[0]!.closeCalls).toHaveLength(0)

    // Once the handshake settles, the deferred close runs against the OPEN socket
    sockets[0]!.finishHandshake()
    expect(sockets[0]!.closeCalls).toEqual([
      {...GRACEFUL_CLOSE, readyStateAtCall: sockets[0]!.OPEN},
    ])
  })

  it('does not close a socket whose handshake failed after unsubscribe', () => {
    const {sockets, conn$} = setup()
    conn$.subscribe().unsubscribe()

    sockets[0]!.disconnect(1006, 'handshake failed')
    expect(sockets[0]!.closeCalls).toHaveLength(0)
  })

  it('throws a connection error if the connection emits an error', () => {
    const {sockets, conn$} = setup()
    const errors: unknown[] = []
    conn$.subscribe({error: (err: unknown) => errors.push(err)})

    sockets[0]!.emitError()

    expect(errors).toHaveLength(1)
    const error = errors[0]
    if (!(error instanceof WebSocketError)) throw new Error('Expected WebSocketError')
    expect(error.type).toBe('CONNECTION_ERROR')
  })

  it('throws an error on unexpected close', () => {
    const {sockets, conn$} = setup()
    const errors: unknown[] = []
    conn$.subscribe({error: (err: unknown) => errors.push(err)})

    sockets[0]!.disconnect(1006, 'Unexpected close')

    expect(errors).toHaveLength(1)
    const error = errors[0]
    if (!(error instanceof WebSocketError)) throw new Error('Expected WebSocketError')
    expect(error.type).toBe('CONNECTION_CLOSED')
    expect(error.code).toBe(1006)
    expect(error.reason).toBe('Unexpected close')
  })

  it('does not error subscribers that have already unsubscribed', () => {
    const {sockets, conn$} = setup()
    const errors: unknown[] = []
    conn$.subscribe({error: (err: unknown) => errors.push(err)}).unsubscribe()

    sockets[0]!.emitError()
    sockets[0]!.disconnect(1006, 'Unexpected close')

    expect(errors).toHaveLength(0)
  })
})
