import {BehaviorSubject, Subject, type Subscription} from 'rxjs'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {type Auth, fromSanityClient, fromUrl, WebSocketError} from '../index'
import {MockWebSocket} from './mockWebSocket'

const SOCKET_URL = 'wss://example.api.sanity.io/v2022-06-30/socket/test'
const IDLE_TIMEOUT = 5_000
const GRACEFUL_CLOSE = {code: 1000, reason: 'WebSockets connection closed by client'}

const methodsSent = (socket: MockWebSocket) =>
  socket.sendCalls.map(({data}) => JSON.parse(data) as {method: string; params: any})

describe('fromUrl closeOn', () => {
  let sockets: MockWebSocket[]
  let subscriptions: Subscription[]
  let closeOn: Subject<void>
  let auth: BehaviorSubject<Promise<Auth | undefined>>

  beforeEach(() => {
    vi.useFakeTimers()
    sockets = []
    subscriptions = []
    closeOn = new Subject<void>()
    auth = new BehaviorSubject<Promise<Auth | undefined>>(Promise.resolve({token: 'token-1'}))
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

  const createClient = () => fromUrl(SOCKET_URL, {auth, idleTimeout: IDLE_TIMEOUT, closeOn})

  async function openAuthorized(client: ReturnType<typeof createClient>, socket = 0) {
    subscriptions.push(client.heartbeats.subscribe({error: () => {}}))
    sockets[socket]!.finishHandshake()
    await vi.advanceTimersByTimeAsync(0)
    sockets[socket]!.respond('authorization', true)
  }

  it('closes the open socket at once, without waiting for idleTimeout', async () => {
    const client = createClient()
    await openAuthorized(client)

    closeOn.next()

    expect(sockets[0]!.closeCalls).toEqual([
      {...GRACEFUL_CLOSE, readyStateAtCall: sockets[0]!.OPEN},
    ])
  })

  it('works through fromSanityClient too', () => {
    const client = fromSanityClient(
      {
        config: () => ({dataset: 'test'}),
        getUrl: (path) => `https://example.api.sanity.io/v2022-06-30${path}`,
      },
      {idleTimeout: IDLE_TIMEOUT, closeOn},
    )
    subscriptions.push(client.heartbeats.subscribe({error: () => {}}))
    sockets[0]!.finishHandshake()

    closeOn.next()

    expect(sockets[0]!.closeCalls).toEqual([
      {...GRACEFUL_CLOSE, readyStateAtCall: sockets[0]!.OPEN},
    ])
  })

  it('errors heartbeats, pending requests and active subscriptions', async () => {
    const client = createClient()
    const errors: unknown[] = []
    subscriptions.push(client.heartbeats.subscribe({error: (err) => errors.push(err)}))
    sockets[0]!.finishHandshake()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.respond('authorization', true)
    subscriptions.push(client.listen('presence').subscribe({error: (err) => errors.push(err)}))
    sockets[0]!.respond('presence_subscribe', 'subscription-id')
    subscriptions.push(
      client.request('presence_rollcall').subscribe({error: (err) => errors.push(err)}),
    )

    closeOn.next()

    expect(errors).toHaveLength(3)
    for (const error of errors) {
      expect(error).toBeInstanceOf(WebSocketError)
      expect((error as WebSocketError).type).toBe('CONNECTION_CLOSED')
      expect((error as WebSocketError).code).toBe(1000)
    }
  })

  it('opens a new socket for the next subscriber, authorized with the current auth', async () => {
    const client = createClient()
    await openAuthorized(client)
    closeOn.next()

    auth.next(Promise.resolve({token: 'token-2'}))
    const results: unknown[] = []
    subscriptions.push(client.request('presence_rollcall').subscribe((r) => results.push(r)))
    expect(sockets).toHaveLength(2)
    sockets[1]!.finishHandshake()
    await vi.advanceTimersByTimeAsync(0)

    expect(methodsSent(sockets[1]!)[0]!.params.authorization).toBe('Bearer token-2')
    sockets[1]!.respond('authorization', true)
    sockets[1]!.respond('presence_rollcall', 'ok')
    expect(results).toEqual(['ok'])
  })

  it('closes the socket during idleTimeout, after the last subscriber left', async () => {
    const client = createClient()
    await openAuthorized(client)
    subscriptions.pop()!.unsubscribe()
    expect(sockets[0]!.closeCalls).toEqual([])

    closeOn.next()

    expect(sockets[0]!.closeCalls).toHaveLength(1)
  })

  it('never closes a socket mid-handshake: the close waits until it opens', () => {
    const client = createClient()
    const errors: unknown[] = []
    subscriptions.push(client.heartbeats.subscribe({error: (err) => errors.push(err)}))

    closeOn.next()

    expect(errors).toHaveLength(1)
    expect(sockets[0]!.closeCalls).toEqual([])
    sockets[0]!.finishHandshake()
    expect(sockets[0]!.closeCalls).toEqual([
      {...GRACEFUL_CLOSE, readyStateAtCall: sockets[0]!.OPEN},
    ])
  })

  it('does nothing when no connection is open', async () => {
    const client = createClient()
    closeOn.next()
    expect(sockets).toHaveLength(0)

    // Also after a connection was opened and fully closed
    await openAuthorized(client)
    subscriptions.pop()!.unsubscribe()
    vi.advanceTimersByTime(IDLE_TIMEOUT)
    expect(sockets[0]!.closeCalls).toHaveLength(1)
    closeOn.next()
    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.closeCalls).toHaveLength(1)
  })
})
