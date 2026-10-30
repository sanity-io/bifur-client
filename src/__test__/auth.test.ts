import {BehaviorSubject, ReplaySubject} from 'rxjs'
import {describe, expect, it} from 'vitest'

import {createClient, RpcError, WebSocketError, type Auth} from '../index'
import {MockWebSocket} from './mockWebSocket'

const methodsSent = (socket: MockWebSocket) =>
  socket.sendCalls.map(({data}) => JSON.parse(data) as {method: string; params: any})

// Lets settled promises run their callbacks
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {promise, resolve, reject}
}

function setup(initial: Promise<Auth | undefined>) {
  const ws = new MockWebSocket('wss://mock')
  ws.finishHandshake()
  const connection$ = new ReplaySubject<WebSocket>(1)
  connection$.next(ws as unknown as WebSocket)
  const auth = new BehaviorSubject<Promise<Auth | undefined>>(initial)
  const client = createClient(connection$, {auth})
  return {ws, auth, client}
}

describe('auth', () => {
  it('authorizes the socket with the resolved token before sending requests', async () => {
    const {ws, client} = setup(Promise.resolve({token: 'token-1'}))
    const results: unknown[] = []
    client.request('presence_rollcall').subscribe((result) => results.push(result))

    await flush()
    expect(methodsSent(ws).map((r) => r.method)).toEqual(['authorization'])
    expect(methodsSent(ws)[0]!.params.authorization).toBe('Bearer token-1')

    ws.respond('authorization', true)
    ws.respond('presence_rollcall', 'ok')
    expect(results).toEqual(['ok'])
  })

  it('holds requests while a renewal is pending, then sends them with the new token', async () => {
    const {ws, auth, client} = setup(Promise.resolve({token: 'token-1'}))
    const heartbeats = client.heartbeats.subscribe({error: () => {}})
    await flush()
    ws.respond('authorization', true)

    // A renewal starts
    const renewal = deferred<Auth | undefined>()
    auth.next(renewal.promise)
    client.request('presence_announce').subscribe({error: () => {}})
    await flush()
    // Nothing is sent with the token that is about to be replaced
    expect(methodsSent(ws).map((r) => r.method)).toEqual(['authorization'])

    renewal.resolve({token: 'token-2'})
    await flush()
    expect(methodsSent(ws)[1]!.params.authorization).toBe('Bearer token-2')
    ws.respond('authorization', true)
    expect(methodsSent(ws).map((r) => r.method)).toEqual([
      'authorization',
      'authorization',
      'presence_announce',
    ])
    heartbeats.unsubscribe()
  })

  it('keeps an active subscription through a renewal on the same socket', async () => {
    const {ws, auth, client} = setup(Promise.resolve({token: 'token-1'}))
    const events: unknown[] = []
    const errors: unknown[] = []
    client.listen('presence').subscribe({
      next: (event) => events.push(event),
      error: (err) => errors.push(err),
    })
    await flush()
    ws.respond('authorization', true)
    ws.respond('presence_subscribe', 'subscription-id')

    const renewal = deferred<Auth | undefined>()
    auth.next(renewal.promise)
    renewal.resolve({token: 'token-2'})
    await flush()
    ws.respond('authorization', true)

    ws.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'presence_subscription',
        params: {subscription: 'subscription-id', result: 'event'},
      }),
    )
    expect(events).toEqual(['event'])
    expect(errors).toEqual([])
    // Not subscribed again, and never unsubscribed
    expect(methodsSent(ws).map((r) => r.method)).toEqual([
      'authorization',
      'presence_subscribe',
      'authorization',
    ])
  })

  it('errors the connection, and sends nothing, when the server rejects the token', async () => {
    const {ws, client} = setup(Promise.resolve({token: 'token-1'}))
    const errors: unknown[] = []
    client.heartbeats.subscribe({error: (err) => errors.push(err)})
    client.request('presence_rollcall').subscribe({error: (err) => errors.push(err)})
    await flush()

    ws.respondError('authorization', 4001, 'Invalid token')

    expect(methodsSent(ws).map((r) => r.method)).toEqual(['authorization'])
    expect(errors).toHaveLength(2)
    for (const error of errors) {
      expect(error).toBeInstanceOf(RpcError)
      expect((error as RpcError).code).toBe(4001)
    }
  })

  it('errors the connection, and sends nothing, when the server closes the socket on the token', async () => {
    // Bifur closes the socket on an invalid token instead of replying
    const {ws, client} = setup(Promise.resolve({token: 'token-1'}))
    const errors: unknown[] = []
    client.heartbeats.subscribe({error: (err) => errors.push(err)})
    client.request('presence_rollcall').subscribe({error: (err) => errors.push(err)})
    await flush()

    ws.disconnect(4001, 'unauthorized')

    expect(methodsSent(ws).map((r) => r.method)).toEqual(['authorization'])
    expect(errors).toHaveLength(2)
    for (const error of errors) {
      expect(error).toBeInstanceOf(WebSocketError)
      expect((error as WebSocketError).code).toBe(4001)
    }
  })

  it('closes the socket, without sending waiting requests, when the token is dropped before its reply', async () => {
    const {ws, auth, client} = setup(Promise.resolve({token: 'token-1'}))
    const errors: unknown[] = []
    client.heartbeats.subscribe({error: (err) => errors.push(err)})
    await flush()

    // The token was sent, so the socket is authorized with it from now on
    auth.next(Promise.resolve({withCredentials: true}))
    client.request('presence_rollcall').subscribe({error: (err) => errors.push(err)})
    await flush()

    expect(methodsSent(ws).map((r) => r.method)).toEqual(['authorization'])
    expect(ws.closeCalls).toHaveLength(1)

    ws.finishClose()
    expect(errors).toHaveLength(2)
    for (const error of errors) {
      expect(error).toBeInstanceOf(WebSocketError)
      expect((error as WebSocketError).code).toBe(1000)
    }
  })

  it('sends a token again when it was replaced by one whose reply is still pending', async () => {
    const {ws, auth, client} = setup(Promise.resolve({token: 'token-1'}))
    const heartbeats = client.heartbeats.subscribe({error: () => {}})
    await flush()
    ws.respond('authorization', true)

    auth.next(Promise.resolve({token: 'token-2'}))
    await flush()
    auth.next(Promise.resolve({token: 'token-1'}))
    await flush()

    expect(methodsSent(ws).map((r) => r.params.authorization)).toEqual([
      'Bearer token-1',
      'Bearer token-2',
      'Bearer token-1',
    ])
    heartbeats.unsubscribe()
  })

  it('waits for the pending authorization when a renewal resolves to the token already sent', async () => {
    const {ws, auth, client} = setup(Promise.resolve({token: 'token-1'}))
    const heartbeats = client.heartbeats.subscribe({error: () => {}})
    await flush()
    // The token was sent, but the server hasn't replied yet
    expect(methodsSent(ws).map((r) => r.method)).toEqual(['authorization'])

    // A renewal resolves to the same token while that reply is still pending
    auth.next(Promise.resolve({token: 'token-1'}))
    client.request('presence_rollcall').subscribe({error: () => {}})
    await flush()

    // The request waits for the reply to the authorization already sent,
    // rather than going out as if it had been confirmed
    expect(methodsSent(ws).map((r) => r.method)).toEqual(['authorization'])
    ws.respond('authorization', true)
    expect(methodsSent(ws).map((r) => r.method)).toEqual(['authorization', 'presence_rollcall'])
    heartbeats.unsubscribe()
  })

  it('does not authorize the socket again when the token is unchanged', async () => {
    const {ws, auth, client} = setup(Promise.resolve({token: 'token-1'}))
    const heartbeats = client.heartbeats.subscribe({error: () => {}})
    await flush()
    ws.respond('authorization', true)

    auth.next(Promise.resolve({token: 'token-1'}))
    client.request('presence_rollcall').subscribe({error: () => {}})
    await flush()

    expect(methodsSent(ws).map((r) => r.method)).toEqual(['authorization', 'presence_rollcall'])
    heartbeats.unsubscribe()
  })

  it('sends no authorization request for cookie credentials', async () => {
    const {ws, client} = setup(Promise.resolve({withCredentials: true}))
    client.request('presence_rollcall').subscribe({error: () => {}})
    await flush()
    expect(methodsSent(ws).map((r) => r.method)).toEqual(['presence_rollcall'])
  })

  it('closes the socket when credentials drop the token it was authorized with', async () => {
    const {ws, auth, client} = setup(Promise.resolve({token: 'token-1'}))
    const errors: unknown[] = []
    client.heartbeats.subscribe({error: (err) => errors.push(err)})
    await flush()
    ws.respond('authorization', true)

    // For example on logout
    auth.next(Promise.resolve(undefined))
    await flush()
    expect(ws.closeCalls).toHaveLength(1)

    ws.finishClose()
    expect(errors).toHaveLength(1)
    expect((errors[0] as WebSocketError).type).toBe('CONNECTION_CLOSED')
    expect((errors[0] as WebSocketError).reason).toMatch(/no longer include a token/)
  })

  it('remembers the token sent on a socket across subscriptions to it', async () => {
    // A new subscriber can pick up the same open socket, as `fromUrl` does
    // during its idle timeout
    const {ws, auth, client} = setup(Promise.resolve({token: 'token-1'}))
    const first = client.heartbeats.subscribe({error: () => {}})
    await flush()
    ws.respond('authorization', true)
    first.unsubscribe()

    // The same token isn't sent again
    const second = client.heartbeats.subscribe({error: () => {}})
    await flush()
    expect(methodsSent(ws).map((r) => r.method)).toEqual(['authorization'])
    second.unsubscribe()

    // Dropping the token still closes the socket
    auth.next(Promise.resolve({withCredentials: true}))
    const third = client.heartbeats.subscribe({error: () => {}})
    await flush()
    expect(ws.closeCalls).toHaveLength(1)
    third.unsubscribe()
  })

  it('sends no authorization request without a token', async () => {
    const {ws, client} = setup(Promise.resolve(undefined))
    client.request('presence_rollcall').subscribe({error: () => {}})
    await flush()
    expect(methodsSent(ws).map((r) => r.method)).toEqual(['presence_rollcall'])
  })

  it('errors the connection, and waiting requests, when a renewal fails', async () => {
    const {ws, auth, client} = setup(Promise.resolve({token: 'token-1'}))
    const errors: unknown[] = []
    client.heartbeats.subscribe({error: (err) => errors.push(err)})
    await flush()
    ws.respond('authorization', true)

    const renewal = deferred<Auth | undefined>()
    auth.next(renewal.promise)
    client.request('presence_announce').subscribe({error: (err) => errors.push(err)})
    const failure = new Error('refresh token refused')
    renewal.reject(failure)
    await flush()

    expect(errors).toEqual([failure, failure])
    expect(methodsSent(ws).map((r) => r.method)).toEqual(['authorization'])
  })
})
