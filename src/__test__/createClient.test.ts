import {BehaviorSubject, config, defer, of, ReplaySubject, retry, type Subscription} from 'rxjs'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {type Auth, createClient, fromUrl, RpcError, WebSocketError} from '../index'
import {MockWebSocket} from './mockWebSocket'

const SOCKET_URL = 'wss://example.api.sanity.io/v2022-06-30/socket/test'

const methodsSent = (socket: MockWebSocket) =>
  socket.sendCalls.map(({data}) => JSON.parse(data).method as string)

// Lets settled promises run their callbacks
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

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

  it('errors the connection when a renewal finds the socket closing', async () => {
    const ws = openSocket()
    const connection$ = new ReplaySubject<WebSocket>(1)
    const auth = new BehaviorSubject<Promise<Auth | undefined>>(Promise.resolve({token: 'token'}))
    const client = createClient(connection$, {auth})
    const errors: unknown[] = []
    client.heartbeats.subscribe({error: (err) => errors.push(err)})
    connection$.next(ws as unknown as WebSocket)
    await flush()
    ws.respond('authorization', true)

    // The server has closed the socket, but the browser hasn't fired `onclose` yet
    ws.readyState = ws.CLOSING
    auth.next(Promise.resolve({token: 'rotated-token'}))
    await flush()

    // Nothing is sent, and the connection errors once `close` fires
    expect(methodsSent(ws)).toEqual(['authorization'])
    expect(errors).toEqual([])
    ws.onclose = null
    ws.disconnect(4001, 'unauthorized')
    expect(errors).toHaveLength(1)
    expect((errors[0] as WebSocketError).type).toBe('CONNECTION_CLOSED')
    expect((errors[0] as WebSocketError).code).toBe(4001)
  })

  it('waits for `close` on a closing socket, so an immediate retry does not spin', () => {
    const ws = openSocket()
    ws.readyState = ws.CLOSING
    const connection$ = new ReplaySubject<WebSocket>(1)
    connection$.next(ws as unknown as WebSocket)
    const client = createClient(connection$)
    let subscriptions = 0
    const errors: unknown[] = []
    defer(() => {
      subscriptions++
      return client.heartbeats
    })
      .pipe(retry(1000))
      .subscribe({error: (err) => errors.push(err)})

    expect(subscriptions).toBe(1)
    expect(errors).toEqual([])
  })

  it('errors the connection with the close code when the socket closes', () => {
    const ws = openSocket()
    const connection$ = new ReplaySubject<WebSocket>(1)
    const client = createClient(connection$)
    const errors: unknown[] = []
    client.heartbeats.subscribe({error: (err) => errors.push(err)})
    connection$.next(ws as unknown as WebSocket)

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

  it('errors heartbeats before subscriptions made after it on a socket that closes', () => {
    // A consumer that stops listening when the connection errors (like the
    // studio's presence store) must never see its subscription error. Here
    // `connection$` doesn't error on close, so the `close` listeners decide.
    const ws = openSocket()
    const connection$ = new ReplaySubject<WebSocket>(1)
    const client = createClient(connection$)
    let listening: Subscription | undefined
    client.heartbeats.subscribe({error: () => listening?.unsubscribe()})
    connection$.next(ws as unknown as WebSocket)
    const listenErrors: unknown[] = []
    listening = client.listen('presence').subscribe({error: (err) => listenErrors.push(err)})
    ws.respond('presence_subscribe', 'subscription-id')

    ws.onclose = null
    ws.disconnect(4001, 'unauthorized')

    expect(listening.closed).toBe(true)
    expect(listenErrors).toEqual([])
  })

  it('errors a request that the server replies to with an error', () => {
    const ws = openSocket()
    const client = createClient(of(ws as unknown as WebSocket))
    const results: unknown[] = []
    const errors: unknown[] = []
    client.request('presence_announce').subscribe({
      next: (result) => results.push(result),
      error: (err) => errors.push(err),
    })

    ws.respondError('presence_announce', -32602, 'Invalid params')

    expect(results).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(RpcError)
    expect((errors[0] as RpcError).code).toBe(-32602)
    expect((errors[0] as RpcError).message).toBe('Invalid params')
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
    const client = createClient(of(ws as unknown as WebSocket))

    const errors: unknown[] = []
    client.heartbeats.subscribe({error: (err) => errors.push(err)})

    expect(ws.sendCalls).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect((errors[0] as WebSocketError).type).toBe('CONNECTION_CLOSED')
  })

  it('errors a request when the buffered socket has closed since it was emitted', () => {
    const ws = openSocket()
    const connection$ = new ReplaySubject<WebSocket>(1)
    const client = createClient(connection$)
    const heartbeats = client.heartbeats.subscribe({error: () => {}})
    connection$.next(ws as unknown as WebSocket)

    // The socket closes without `connection$` erroring. `fromUrl` doesn't do
    // this (it errors on `onclose`), but a custom `connection$` might
    ws.readyState = ws.CLOSED

    const errors: unknown[] = []
    client.request('presence_announce').subscribe({error: (err) => errors.push(err)})

    expect(ws.sendCalls).toEqual([])
    expect(errors).toHaveLength(1)
    expect((errors[0] as WebSocketError).type).toBe('CONNECTION_CLOSED')
    heartbeats.unsubscribe()
  })
})

describe('fromUrl', () => {
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

  it('closes the socket once the last subscriber leaves', () => {
    const client = fromUrl(SOCKET_URL)
    const heartbeats = client.heartbeats.subscribe({error: () => {}})
    sockets[0]!.finishHandshake()
    heartbeats.unsubscribe()

    expect(sockets[0]!.closeCalls).toHaveLength(1)
  })

  it('closes the socket once a single request settles', () => {
    const client = fromUrl(SOCKET_URL)
    const results: unknown[] = []
    client.request('presence_announce').subscribe((result) => results.push(result))
    sockets[0]!.finishHandshake()

    // The request keeps the socket open until its reply arrives, however long
    // that takes
    vi.advanceTimersByTime(10_000)
    expect(sockets[0]!.closeCalls).toEqual([])
    sockets[0]!.respond('presence_announce', 'ok')
    expect(results).toEqual(['ok'])

    expect(sockets[0]!.closeCalls).toHaveLength(1)
  })

  it('keeps the socket open while a subscription is active', () => {
    const client = fromUrl(SOCKET_URL)
    const results: unknown[] = []
    const listening = client.listen('presence').subscribe((result) => results.push(result))
    sockets[0]!.finishHandshake()
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

  it('reconnects with the current token after the server closes the socket', async () => {
    // The studio's `auth` never completes
    const auth = new BehaviorSubject<Promise<Auth | undefined>>(Promise.resolve({token: 'token'}))
    const client = fromUrl(SOCKET_URL, {auth})
    const heartbeatErrors: unknown[] = []
    subscriptions.push(client.heartbeats.subscribe({error: (err) => heartbeatErrors.push(err)}))
    sockets[0]!.finishHandshake()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.respond('authorization', true)

    // The server has started closing the socket, but `close` hasn't fired yet.
    // A request now waits without writing to the socket.
    sockets[0]!.readyState = sockets[0]!.CLOSING
    const closingErrors: unknown[] = []
    client.request('presence_announce').subscribe({error: (err) => closingErrors.push(err)})
    expect(closingErrors).toEqual([])
    expect(methodsSent(sockets[0]!)).toEqual(['authorization'])
    // No socket is opened just to listen for a reply
    expect(sockets).toHaveLength(1)

    // Once the socket has closed, `heartbeats` and the request error with the
    // close code
    sockets[0]!.disconnect(4001, 'unauthorized')
    expect(heartbeatErrors).toHaveLength(1)
    expect((heartbeatErrors[0] as WebSocketError).code).toBe(4001)
    expect((closingErrors[0] as WebSocketError).code).toBe(4001)

    // The next request opens a new socket, authorizes it with the current
    // token, and sends there
    auth.next(Promise.resolve({token: 'rotated-token'}))
    const results: unknown[] = []
    subscriptions.push(client.request('presence_announce').subscribe((r) => results.push(r)))
    expect(sockets).toHaveLength(2)
    sockets[1]!.finishHandshake()
    await vi.advanceTimersByTimeAsync(0)
    expect(JSON.parse(sockets[1]!.sendCalls[0]!.data).params.authorization).toBe(
      'Bearer rotated-token',
    )
    sockets[1]!.respond('authorization', true)
    sockets[1]!.respond('presence_announce', 'ok')
    expect(results).toEqual(['ok'])
    expect(methodsSent(sockets[1]!)).toEqual(['authorization', 'presence_announce'])
    expect(methodsSent(sockets[0]!)).toEqual(['authorization'])
  })

  it('reconnects without the token after credentials drop it', async () => {
    const auth = new BehaviorSubject<Promise<Auth | undefined>>(Promise.resolve({token: 'token'}))
    const client = fromUrl(SOCKET_URL, {auth, idleTimeout: 5_000})
    subscriptions.push(client.heartbeats.subscribe({error: () => {}}))
    sockets[0]!.finishHandshake()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.respond('authorization', true)

    // Logout: the socket is closed rather than kept with the old token
    auth.next(Promise.resolve(undefined))
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets[0]!.closeCalls).toHaveLength(1)
    sockets[0]!.finishClose()

    // The next request goes out on a new socket, without a token
    const results: unknown[] = []
    subscriptions.push(client.request('presence_announce').subscribe((r) => results.push(r)))
    expect(sockets).toHaveLength(2)
    sockets[1]!.finishHandshake()
    await vi.advanceTimersByTimeAsync(0)
    sockets[1]!.respond('presence_announce', 'ok')
    expect(results).toEqual(['ok'])
    expect(methodsSent(sockets[1]!)).toEqual(['presence_announce'])
  })

  it('opens one socket for heartbeats, requests and subscriptions', () => {
    const client = fromUrl(SOCKET_URL)
    subscriptions.push(client.heartbeats.subscribe({error: () => {}}))
    subscriptions.push(client.request('presence_rollcall').subscribe({error: () => {}}))
    subscriptions.push(client.listen('presence').subscribe({error: () => {}}))
    sockets[0]!.finishHandshake()

    expect(sockets).toHaveLength(1)
    expect(methodsSent(sockets[0]!)).toEqual(['presence_rollcall', 'presence_subscribe'])
  })

  it('keeps the token sent on a socket while it waits out its idle timeout', async () => {
    const auth = new BehaviorSubject<Promise<Auth | undefined>>(Promise.resolve({token: 'token'}))
    const client = fromUrl(SOCKET_URL, {auth, idleTimeout: 5_000})
    const first = client.heartbeats.subscribe({error: () => {}})
    sockets[0]!.finishHandshake()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.respond('authorization', true)
    first.unsubscribe()

    // A new subscriber within the idle timeout reuses the socket, and doesn't
    // send the token again
    await vi.advanceTimersByTimeAsync(1_000)
    subscriptions.push(client.heartbeats.subscribe({error: () => {}}))
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(1)
    expect(methodsSent(sockets[0]!)).toEqual(['authorization'])
  })

  it('closes an idle socket when credentials drop its token, so the next request connects without it', async () => {
    const auth = new BehaviorSubject<Promise<Auth | undefined>>(Promise.resolve({token: 'token'}))
    const client = fromUrl(SOCKET_URL, {auth, idleTimeout: 5_000})
    const heartbeats = client.heartbeats.subscribe({error: () => {}})
    sockets[0]!.finishHandshake()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.respond('authorization', true)
    heartbeats.unsubscribe()

    // Logout while nothing uses the socket
    auth.next(Promise.resolve(undefined))
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets[0]!.closeCalls).toHaveLength(1)
    sockets[0]!.finishClose()

    const results: unknown[] = []
    subscriptions.push(client.request('presence_rollcall').subscribe((r) => results.push(r)))
    expect(sockets).toHaveLength(2)
    sockets[1]!.finishHandshake()
    await vi.advanceTimersByTimeAsync(0)
    sockets[1]!.respond('presence_rollcall', 'ok')
    expect(results).toEqual(['ok'])
    expect(methodsSent(sockets[1]!)).toEqual(['presence_rollcall'])
  })

  it('authorizes an idle socket with a renewed token', async () => {
    const auth = new BehaviorSubject<Promise<Auth | undefined>>(Promise.resolve({token: 'token-1'}))
    const client = fromUrl(SOCKET_URL, {auth, idleTimeout: 5_000})
    const heartbeats = client.heartbeats.subscribe({error: () => {}})
    sockets[0]!.finishHandshake()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.respond('authorization', true)
    heartbeats.unsubscribe()

    // Renewed while nothing uses the socket
    auth.next(Promise.resolve({token: 'token-2'}))
    await vi.advanceTimersByTimeAsync(0)

    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.sendCalls.map(({data}) => JSON.parse(data).params.authorization)).toEqual([
      'Bearer token-1',
      'Bearer token-2',
    ])
  })

  it('sends a rejected token again on a new socket when the consumer retries', async () => {
    const auth = new BehaviorSubject<Promise<Auth | undefined>>(Promise.resolve({token: 'token'}))
    const client = fromUrl(SOCKET_URL, {auth, idleTimeout: 5_000})
    const errors: unknown[] = []
    subscriptions.push(
      client.heartbeats.pipe(retry(1)).subscribe({error: (err) => errors.push(err)}),
    )
    sockets[0]!.finishHandshake()
    await vi.advanceTimersByTimeAsync(0)

    // The rejection resets the connection and closes its socket, even though
    // `idleTimeout` would otherwise keep it, so the retry starts afresh
    sockets[0]!.respondError('authorization', 4001, 'Invalid token')
    expect(sockets[0]!.closeCalls).toHaveLength(1)
    expect(sockets).toHaveLength(2)
    sockets[1]!.finishHandshake()
    await vi.advanceTimersByTimeAsync(0)
    expect(methodsSent(sockets[1]!)).toEqual(['authorization'])

    sockets[1]!.respondError('authorization', 4001, 'Invalid token')
    expect(errors).toHaveLength(1)
    expect((errors[0] as RpcError).code).toBe(4001)
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

    it('does not error when the socket closes after the last subscriber leaves', () => {
      const client = fromUrl(SOCKET_URL)
      const errors: unknown[] = []
      const heartbeats = client.heartbeats.subscribe({error: (err) => errors.push(err)})
      sockets[0]!.finishHandshake()
      heartbeats.unsubscribe()

      expect(sockets[0]!.closeCalls).toHaveLength(1)
      expect(sockets[0]!.listenerCount('close')).toBe(0)

      sockets[0]!.finishClose()
      expect(errors).toEqual([])
      expect(unhandledErrors).toEqual([])
    })

    it('does not error when the socket closes after requests and subscriptions have left', () => {
      const client = fromUrl(SOCKET_URL)
      const errors: unknown[] = []
      const heartbeats = client.heartbeats.subscribe({error: (err) => errors.push(err)})
      sockets[0]!.finishHandshake()
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
