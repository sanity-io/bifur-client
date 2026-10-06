import {BehaviorSubject, of, ReplaySubject} from 'rxjs'
import {describe, expect, it} from 'vitest'

import {createClient, type Auth} from '../index'
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

  it('cannot be combined with token$', () => {
    expect(() =>
      createClient(of(), {
        auth: of(Promise.resolve({token: 'a'})),
        // oxlint-disable-next-line no-deprecated -- checks the deprecated option is rejected
        token$: of('b'),
      }),
    ).toThrow(/either `auth` or `token\$`/)
  })
})
