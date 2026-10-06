import {of, Subject, timer, type Subscription} from 'rxjs'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {fromSanityClient, fromUrl, WebSocketError} from '../index'
import {MockWebSocket} from './mockWebSocket'

const SOCKET_URL = 'wss://example.api.sanity.io/v2022-06-30/socket/test'
const IDLE_TIMEOUT = 5_000

const GRACEFUL_CLOSE = {
  code: 1000,
  reason: 'WebSockets connection closed by client',
}

describe('fromUrl', () => {
  let sockets: MockWebSocket[]
  let subscriptions: Subscription[]
  let unloadTarget: EventTarget

  /**
   * `heartbeats` subscribes to the underlying connection, so it drives the
   * connection lifecycle through the public API.
   */
  const subscribeToConnection = (
    client: ReturnType<typeof fromUrl>,
    observer?: {
      next?: (date: Date) => void
      error?: (err: unknown) => void
      complete?: () => void
    },
  ) => {
    const subscription = client.heartbeats.subscribe({
      next: observer?.next,
      error: observer?.error ?? (() => {}),
      complete: observer?.complete,
    })
    subscriptions.push(subscription)
    return subscription
  }

  beforeEach(() => {
    vi.useFakeTimers()
    sockets = []
    subscriptions = []
    // Node's globalThis is no EventTarget — graft one on to test page events
    unloadTarget = new EventTarget()
    vi.stubGlobal('addEventListener', unloadTarget.addEventListener.bind(unloadTarget))
    vi.stubGlobal('removeEventListener', unloadTarget.removeEventListener.bind(unloadTarget))
    vi.stubGlobal(
      'WebSocket',
      class extends MockWebSocket {
        constructor(url: string) {
          super(url)
          sockets.push(this)
        }
      },
    )
  })

  afterEach(() => {
    for (const subscription of subscriptions) subscription.unsubscribe()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('opens a single connection shared by every subscriber', () => {
    const client = fromUrl(SOCKET_URL)
    const received: Date[] = []
    subscribeToConnection(client, {next: (date) => received.push(date)})
    subscribeToConnection(client, {next: (date) => received.push(date)})

    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.url).toBe(SOCKET_URL)
    expect(received).toHaveLength(0)

    sockets[0]!.finishHandshake()

    expect(sockets).toHaveLength(1)
    expect(received).toHaveLength(2)
  })

  it('closes an open socket as soon as the last subscriber leaves, by default', () => {
    const client = fromUrl(SOCKET_URL)
    subscribeToConnection(client)
    sockets[0]!.finishHandshake()
    subscriptions.pop()!.unsubscribe()

    expect(sockets[0]!.closeCalls).toEqual([
      {...GRACEFUL_CLOSE, readyStateAtCall: sockets[0]!.OPEN},
    ])
    // No timer is left pending
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the socket open after the last subscriber leaves with an infinite delay', () => {
    const client = fromUrl(SOCKET_URL, {idleTimeout: Infinity})
    subscribeToConnection(client)
    sockets[0]!.finishHandshake()
    subscriptions.pop()!.unsubscribe()

    vi.advanceTimersByTime(60_000)
    expect(sockets[0]!.closeCalls).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('decides how long to stay open each time the last subscriber leaves, with a function', () => {
    let hidden = false
    const client = fromUrl(SOCKET_URL, {
      idleTimeout: () => (hidden ? of(0) : timer(IDLE_TIMEOUT)),
    })

    // Visible: a grace period, and a subscriber arriving within it reuses the socket
    subscribeToConnection(client)
    sockets[0]!.finishHandshake()
    subscriptions.pop()!.unsubscribe()
    vi.advanceTimersByTime(IDLE_TIMEOUT - 1)
    expect(sockets[0]!.closeCalls).toEqual([])
    subscribeToConnection(client)
    vi.advanceTimersByTime(IDLE_TIMEOUT)
    expect(sockets[0]!.closeCalls).toEqual([])

    // Hidden: closed as soon as the last subscriber leaves
    hidden = true
    subscriptions.pop()!.unsubscribe()
    expect(sockets[0]!.closeCalls).toHaveLength(1)
  })

  it('closes when a notifier from the idleTimeout function emits', () => {
    const pagehide = new Subject<void>()
    const client = fromUrl(SOCKET_URL, {idleTimeout: () => pagehide})
    subscribeToConnection(client)
    sockets[0]!.finishHandshake()
    subscriptions.pop()!.unsubscribe()

    vi.advanceTimersByTime(60_000)
    expect(sockets[0]!.closeCalls).toEqual([])
    pagehide.next()
    expect(sockets[0]!.closeCalls).toHaveLength(1)
  })

  it('passes idleTimeout through fromSanityClient', () => {
    const client = fromSanityClient(
      {
        config: () => ({dataset: 'test'}),
        getUrl: (path) => `https://example.api.sanity.io/v2022-06-30${path}`,
      },
      {idleTimeout: IDLE_TIMEOUT},
    )
    subscribeToConnection(client)
    expect(sockets[0]!.url).toBe(SOCKET_URL)
    sockets[0]!.finishHandshake()
    subscriptions.pop()!.unsubscribe()

    expect(sockets[0]!.closeCalls).toEqual([])
    vi.advanceTimersByTime(IDLE_TIMEOUT)
    expect(sockets[0]!.closeCalls).toHaveLength(1)
  })

  it('keeps an in-flight handshake alive across a momentary zero-subscriber gap', () => {
    const client = fromUrl(SOCKET_URL, {idleTimeout: IDLE_TIMEOUT})
    subscribeToConnection(client).unsubscribe()

    // the regression: this used to close the CONNECTING socket immediately
    expect(sockets[0]!.closeCalls).toHaveLength(0)

    const received: Date[] = []
    subscribeToConnection(client, {next: (date) => received.push(date)})
    sockets[0]!.finishHandshake()

    expect(sockets).toHaveLength(1)
    expect(received).toHaveLength(1)
    expect(sockets[0]!.closeCalls).toHaveLength(0)
  })

  it('reuses the open socket for subscribers arriving before the idle timeout elapses', () => {
    const client = fromUrl(SOCKET_URL, {idleTimeout: IDLE_TIMEOUT})
    subscribeToConnection(client)
    sockets[0]!.finishHandshake()
    subscriptions.pop()!.unsubscribe()

    const received: Date[] = []
    subscribeToConnection(client, {next: (date) => received.push(date)})

    expect(received).toHaveLength(1)
    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.closeCalls).toHaveLength(0)
  })

  it('closes an open socket gracefully once the idle timeout elapses without subscribers', () => {
    const client = fromUrl(SOCKET_URL, {idleTimeout: IDLE_TIMEOUT})
    subscribeToConnection(client)
    sockets[0]!.finishHandshake()
    subscriptions.pop()!.unsubscribe()

    expect(sockets[0]!.closeCalls).toHaveLength(0)

    vi.runAllTimers()
    expect(sockets[0]!.closeCalls).toEqual([
      {...GRACEFUL_CLOSE, readyStateAtCall: sockets[0]!.OPEN},
    ])

    // A subscriber arriving after the disconnect starts a fresh connection
    subscribeToConnection(client)
    expect(sockets).toHaveLength(2)
  })

  it('never closes a socket mid-handshake: teardown while connecting defers the close until open', () => {
    const client = fromUrl(SOCKET_URL)
    // Socket is still CONNECTING when the last subscriber leaves
    subscribeToConnection(client).unsubscribe()
    expect(sockets[0]!.closeCalls).toHaveLength(0)

    // Once the handshake settles, the deferred close runs against the OPEN socket
    sockets[0]!.finishHandshake()
    expect(sockets[0]!.closeCalls).toEqual([
      {...GRACEFUL_CLOSE, readyStateAtCall: sockets[0]!.OPEN},
    ])
  })

  it('errors subscribers when the connection closes unexpectedly, and reconnects on resubscribe', () => {
    const client = fromUrl(SOCKET_URL)
    const errors: unknown[] = []
    subscribeToConnection(client, {error: (err) => errors.push(err)})
    sockets[0]!.finishHandshake()

    sockets[0]!.disconnect(4001, 'unauthorized')

    expect(errors).toHaveLength(1)
    const error = errors[0]
    if (!(error instanceof WebSocketError)) throw new Error('Expected WebSocketError')
    expect(error.type).toBe('CONNECTION_CLOSED')
    expect(error.code).toBe(4001)
    expect(error.reason).toBe('unauthorized')

    // The share resets on error, so the next subscriber triggers a new connection
    subscribeToConnection(client)
    expect(sockets).toHaveLength(2)
  })

  it('errors subscribers when the socket errors', () => {
    const client = fromUrl(SOCKET_URL)
    const errors: unknown[] = []
    subscribeToConnection(client, {error: (err) => errors.push(err)})

    sockets[0]!.emitError()

    expect(errors).toHaveLength(1)
    const error = errors[0]
    if (!(error instanceof WebSocketError)) throw new Error('Expected WebSocketError')
    expect(error.type).toBe('CONNECTION_ERROR')
  })

  it('leaves closing the socket on page unload to the browser', () => {
    const client = fromUrl(SOCKET_URL)
    subscribeToConnection(client)
    sockets[0]!.finishHandshake()

    // The page may stay after either event: an "unsaved changes" prompt can be
    // cancelled after `beforeunload`, and a page restored from the
    // back/forward cache comes back after `pagehide`. The browser closes the
    // socket itself when the page is unloaded.
    unloadTarget.dispatchEvent(new Event('beforeunload'))
    unloadTarget.dispatchEvent(new Event('pagehide'))

    expect(sockets[0]!.closeCalls).toEqual([])
    expect(sockets[0]!.readyState).toBe(sockets[0]!.OPEN)
  })
})
