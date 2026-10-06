import {BehaviorSubject, config, of, ReplaySubject, type Subscription} from 'rxjs'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createClient, fromUrl, WebSocketError} from '../index'
import {MockWebSocket} from './mockWebSocket'

const SOCKET_URL = 'wss://example.api.sanity.io/v2022-06-30/socket/test'

const methodsSent = (socket: MockWebSocket) =>
  socket.sendCalls.map(({data}) => JSON.parse(data).method as string)

const openSocket = () => {
  const ws = new MockWebSocket(SOCKET_URL)
  ws.finishHandshake()
  return ws
}

describe('createClient', () => {
  it('errors a request instead of writing to a socket that is not open', () => {
    const ws = openSocket()
    ws.disconnect(4001, 'unauthorized')
    const client = createClient(of(ws as unknown as WebSocket))

    const errors: unknown[] = []
    client.request('presence_announce').subscribe({error: (err) => errors.push(err)})

    expect(ws.sendCalls).toHaveLength(0)
    expect(errors).toHaveLength(1)
    const error = errors[0]
    if (!(error instanceof WebSocketError)) throw new Error('Expected WebSocketError')
    expect(error.type).toBe('CONNECTION_CLOSED')
  })

  it('sends on an open socket that lacks the readyState constants', () => {
    const ws = {
      readyState: 1,
      sent: [] as string[],
      send(data: string) {
        this.sent.push(data)
      },
      addEventListener() {},
      removeEventListener() {},
    }
    const client = createClient(of(ws as unknown as WebSocket))

    const errors: unknown[] = []
    client.request('presence_announce').subscribe({error: (err) => errors.push(err)})

    expect(errors).toEqual([])
    expect(ws.sent.map((data) => JSON.parse(data).method)).toEqual(['presence_announce'])
  })

  it('errors a subscription instead of writing to a socket that is not open', () => {
    const ws = openSocket()
    ws.disconnect(4001, 'unauthorized')
    const client = createClient(of(ws as unknown as WebSocket))

    const errors: unknown[] = []
    client.listen('presence').subscribe({error: (err) => errors.push(err)})

    expect(ws.sendCalls).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect((errors[0] as WebSocketError).type).toBe('CONNECTION_CLOSED')
  })

  it('errors the connection when a token change finds the socket closing', () => {
    const ws = openSocket()
    const connection$ = new ReplaySubject<WebSocket>(1)
    const token$ = new BehaviorSubject<string | null>('token')
    const client = createClient(connection$, {token$})
    const errors: unknown[] = []
    client.heartbeats.subscribe({error: (err) => errors.push(err)})
    connection$.next(ws as unknown as WebSocket)
    ws.respond('authorization', true)

    // The server has closed the socket, but the browser hasn't fired `onclose` yet
    ws.readyState = ws.CLOSING
    token$.next('rotated-token')

    expect(ws.sendCalls.map(({data}) => JSON.parse(data).method)).toEqual(['authorization'])
    expect(errors).toHaveLength(1)
    expect((errors[0] as WebSocketError).type).toBe('CONNECTION_CLOSED')
  })

  it('errors the connection with the close code when the socket closes', () => {
    const ws = openSocket()
    const connection$ = new ReplaySubject<WebSocket>(1)
    const client = createClient(connection$, {token$: of('token')})
    const errors: unknown[] = []
    client.heartbeats.subscribe({error: (err) => errors.push(err)})
    connection$.next(ws as unknown as WebSocket)
    ws.respond('authorization', true)

    // `connection$` itself neither errors nor completes
    ws.onclose = null
    ws.disconnect(4001, 'unauthorized')

    expect(errors).toHaveLength(1)
    const error = errors[0]
    if (!(error instanceof WebSocketError)) throw new Error('Expected WebSocketError')
    expect(error.type).toBe('CONNECTION_CLOSED')
    expect(error.code).toBe(4001)
    expect(error.reason).toBe('unauthorized')
  })

  it('errors heartbeats before the subscriptions on a socket that closes', () => {
    // A consumer that stops listening when the connection errors (like the
    // studio's presence store) must never see its subscription error. Here
    // `connection$` doesn't error on close, so the `close` listeners decide.
    const ws = openSocket()
    const connection$ = new ReplaySubject<WebSocket>(1)
    const client = createClient(connection$, {token$: of('token')})
    let listening: Subscription | undefined
    client.heartbeats.subscribe({error: () => listening?.unsubscribe()})
    connection$.next(ws as unknown as WebSocket)
    const listenErrors: unknown[] = []
    listening = client.listen('presence').subscribe({error: (err) => listenErrors.push(err)})
    ws.respond('authorization', true)
    ws.respond('presence_subscribe', 'subscription-id')

    ws.onclose = null
    ws.disconnect(4001, 'unauthorized')

    expect(listening.closed).toBe(true)
    expect(listenErrors).toEqual([])
  })

  it('errors a pending request and subscription when their socket closes', () => {
    const ws = openSocket()
    const client = createClient(of(ws as unknown as WebSocket))
    const errors: unknown[] = []
    client.request('presence_rollcall').subscribe({error: (err) => errors.push(err)})
    client.listen('presence').subscribe({error: (err) => errors.push(err)})
    ws.respond('presence_subscribe', 'subscription-id')

    ws.disconnect(4001, 'unauthorized')

    expect(errors).toHaveLength(2)
    for (const error of errors) {
      expect((error as WebSocketError).type).toBe('CONNECTION_CLOSED')
      expect((error as WebSocketError).code).toBe(4001)
    }
  })

  it('parses each message once, however many requests are waiting on the socket', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = openSocket()
    const connection$ = new ReplaySubject<WebSocket>(1)
    connection$.next(ws as unknown as WebSocket)
    const client = createClient(connection$)
    const subscriptions = [
      client.heartbeats.subscribe({error: () => {}}),
      client.request('presence_rollcall').subscribe({error: () => {}}),
      client.request('presence_announce').subscribe({error: () => {}}),
      client.listen('presence').subscribe({error: () => {}}),
    ]

    ws.receive('not json')

    expect(warn).toHaveBeenCalledTimes(1)
    for (const subscription of subscriptions) subscription.unsubscribe()
    warn.mockRestore()
  })

  it('errors the connection when connection$ emits a socket that is already closed', () => {
    const ws = openSocket()
    ws.disconnect(4001, 'unauthorized')
    const client = createClient(of(ws as unknown as WebSocket), {token$: of('token')})

    const errors: unknown[] = []
    client.heartbeats.subscribe({error: (err) => errors.push(err)})

    expect(ws.sendCalls).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect((errors[0] as WebSocketError).type).toBe('CONNECTION_CLOSED')
  })

  it('errors a request when the buffered socket has closed since it was authorized', () => {
    const ws = openSocket()
    const connection$ = new ReplaySubject<WebSocket>(1)
    const client = createClient(connection$, {token$: of('token')})
    const heartbeats = client.heartbeats.subscribe({error: () => {}})
    connection$.next(ws as unknown as WebSocket)
    ws.respond('authorization', true)

    // The socket closes without `connection$` erroring. `fromUrl` doesn't do
    // this (it errors on `onclose`), but a custom `connection$` might
    ws.readyState = ws.CLOSED

    const errors: unknown[] = []
    client.request('presence_announce').subscribe({error: (err) => errors.push(err)})

    expect(ws.sendCalls.map(({data}) => JSON.parse(data).method)).toEqual(['authorization'])
    expect(errors).toHaveLength(1)
    expect((errors[0] as WebSocketError).type).toBe('CONNECTION_CLOSED')
    heartbeats.unsubscribe()
  })
})

describe('fromUrl with token$', () => {
  let sockets: MockWebSocket[]
  let subscriptions: Subscription[]

  beforeEach(() => {
    vi.useFakeTimers()
    sockets = []
    subscriptions = []
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

  it('closes the socket once the disconnect grace elapses after the last subscriber leaves', () => {
    const client = fromUrl(SOCKET_URL, {token$: of('token')})
    const heartbeats = client.heartbeats.subscribe({error: () => {}})
    sockets[0]!.finishHandshake()
    sockets[0]!.respond('authorization', true)
    heartbeats.unsubscribe()

    vi.advanceTimersByTime(10_000)
    expect(sockets[0]!.closeCalls).toHaveLength(1)
  })

  it('closes the socket once the disconnect grace elapses after a single request settles', () => {
    const client = fromUrl(SOCKET_URL, {token$: of('token')})
    const results: unknown[] = []
    client.request('presence_announce').subscribe((result) => results.push(result))
    sockets[0]!.finishHandshake()
    sockets[0]!.respond('authorization', true)

    // The request keeps the socket open until its reply arrives, however long
    // that takes
    vi.advanceTimersByTime(10_000)
    expect(sockets[0]!.closeCalls).toEqual([])
    sockets[0]!.respond('presence_announce', 'ok')
    expect(results).toEqual(['ok'])

    vi.advanceTimersByTime(10_000)
    expect(sockets[0]!.closeCalls).toHaveLength(1)
  })

  it('keeps the socket open while a subscription is active', () => {
    const client = fromUrl(SOCKET_URL, {token$: of('token')})
    const results: unknown[] = []
    const listening = client.listen('presence').subscribe((result) => results.push(result))
    sockets[0]!.finishHandshake()
    sockets[0]!.respond('authorization', true)
    sockets[0]!.respond('presence_subscribe', 'subscription-id')

    vi.advanceTimersByTime(10_000)
    expect(sockets[0]!.closeCalls).toEqual([])
    sockets[0]!.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'presence_subscription',
        params: {subscription: 'subscription-id', result: 'event'},
      }),
    )
    expect(results).toEqual(['event'])

    listening.unsubscribe()
    vi.advanceTimersByTime(10_000)
    expect(sockets[0]!.closeCalls).toHaveLength(1)
  })

  it('reconnects with the current token after the server closes the socket', () => {
    // The studio's `token$` never completes
    const token$ = new BehaviorSubject<string | null>('token')
    const client = fromUrl(SOCKET_URL, {token$})
    const heartbeatErrors: unknown[] = []
    subscriptions.push(client.heartbeats.subscribe({error: (err) => heartbeatErrors.push(err)}))
    sockets[0]!.finishHandshake()
    sockets[0]!.respond('authorization', true)

    // The server has started closing the socket, but `close` hasn't fired yet.
    // A request now errors without writing to the socket.
    sockets[0]!.readyState = sockets[0]!.CLOSING
    const closingErrors: unknown[] = []
    client.request('presence_announce').subscribe({error: (err) => closingErrors.push(err)})
    expect((closingErrors[0] as WebSocketError).type).toBe('CONNECTION_CLOSED')
    expect(methodsSent(sockets[0]!)).toEqual(['authorization'])
    // No socket is opened just to listen for a reply
    expect(sockets).toHaveLength(1)

    // Once the socket has closed, `heartbeats` errors with the close code
    sockets[0]!.disconnect(4001, 'unauthorized')
    expect(heartbeatErrors).toHaveLength(1)
    expect((heartbeatErrors[0] as WebSocketError).code).toBe(4001)

    // The next request opens a new socket, authorizes it with the current
    // token, and sends there
    token$.next('rotated-token')
    const results: unknown[] = []
    subscriptions.push(client.request('presence_announce').subscribe((r) => results.push(r)))
    expect(sockets).toHaveLength(2)
    sockets[1]!.finishHandshake()
    expect(JSON.parse(sockets[1]!.sendCalls[0]!.data).params.authorization).toBe(
      'Bearer rotated-token',
    )
    sockets[1]!.respond('authorization', true)
    sockets[1]!.respond('presence_announce', 'ok')
    expect(results).toEqual(['ok'])
    expect(methodsSent(sockets[1]!)).toEqual(['authorization', 'presence_announce'])
    expect(methodsSent(sockets[0]!)).toEqual(['authorization'])
  })

  describe('unsubscribing', () => {
    // rxjs reports errors that reach no subscriber here
    let unhandledErrors: unknown[]
    beforeEach(() => {
      unhandledErrors = []
      config.onUnhandledError = (err) => unhandledErrors.push(err)
    })
    afterEach(() => {
      config.onUnhandledError = null
    })

    it('does not error when the disconnect grace closes the socket', () => {
      const client = fromUrl(SOCKET_URL, {token$: new BehaviorSubject<string | null>('token')})
      const errors: unknown[] = []
      const heartbeats = client.heartbeats.subscribe({error: (err) => errors.push(err)})
      sockets[0]!.finishHandshake()
      sockets[0]!.respond('authorization', true)
      heartbeats.unsubscribe()

      vi.advanceTimersByTime(10_000)
      expect(sockets[0]!.closeCalls).toHaveLength(1)
      expect(sockets[0]!.listenerCount('close')).toBe(0)

      sockets[0]!.finishClose()
      expect(errors).toEqual([])
      expect(unhandledErrors).toEqual([])
    })

    it('does not error when the socket closes after requests and subscriptions have left', () => {
      const client = fromUrl(SOCKET_URL, {token$: new BehaviorSubject<string | null>('token')})
      const errors: unknown[] = []
      const heartbeats = client.heartbeats.subscribe({error: (err) => errors.push(err)})
      sockets[0]!.finishHandshake()
      sockets[0]!.respond('authorization', true)
      const request = client
        .request('presence_rollcall')
        .subscribe({error: (err) => errors.push(err)})
      const listen = client.listen('presence').subscribe({error: (err) => errors.push(err)})
      sockets[0]!.respond('presence_subscribe', 'subscription-id')

      request.unsubscribe()
      listen.unsubscribe()
      heartbeats.unsubscribe()
      expect(sockets[0]!.listenerCount('close')).toBe(0)
      // The socket was still open, so the subscription is ended on the server
      expect(methodsSent(sockets[0]!)).toContain('presence_unsubscribe')

      sockets[0]!.disconnect(4001, 'unauthorized')
      expect(errors).toEqual([])
      expect(unhandledErrors).toEqual([])
    })
  })
})
