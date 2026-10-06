import {customAlphabet} from 'nanoid'
import {
  defer,
  distinctUntilChanged,
  EMPTY,
  exhaustMap,
  filter,
  finalize,
  fromEvent,
  map,
  merge,
  mergeMap,
  mergeWith,
  Observable,
  of,
  partition,
  ReplaySubject,
  share,
  switchMap,
  take,
  throwError,
} from 'rxjs'

import {WebSocketError} from './createConnect'
import type {
  BifurClient,
  JSONRpcMessage,
  RequestMethod,
  RequestParams,
  SubscribeMethods,
} from './types'

// at 1000 IDs per second ~4 million years needed in order to have a 1% probability of at least one collision.
// => https://zelark.github.io/nano-id-cc/
const defaultGetNextRequestId = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-',
  20,
)

const HEARTBEAT = '♥'

// `WebSocket.OPEN`, fixed by the WebSocket spec. Compared as a literal so a
// socket object without the readyState constants still works.
const READY_STATE_OPEN = 1
const READY_STATE_CLOSED = 3

function closedError(event?: {code: number; reason: string}) {
  return new WebSocketError(
    'WebSocket connection closed',
    'CONNECTION_CLOSED',
    event?.code,
    event?.reason,
  )
}

// Errors when the socket closes. An already closed socket won't fire `close`
// again, so it errors straight away.
function errorOnClose(ws: WebSocket): Observable<never> {
  return defer(() =>
    ws.readyState === READY_STATE_CLOSED
      ? throwError(() => closedError())
      : fromEvent<CloseEvent>(ws, 'close').pipe(
          mergeMap((event) => throwError(() => closedError(event))),
        ),
  )
}

function formatRequest(method: string, params: RequestParams, id: string) {
  return JSON.stringify({
    jsonrpc: '2.0',
    method,
    params: addApiVersion(params, 'v1'),
    id,
  })
}

function tryParse(input: string): [Error] | [null, JSONRpcMessage<any>] {
  try {
    return [null, JSON.parse(input) as JSONRpcMessage<any>]
  } catch (error: unknown) {
    return error instanceof Error ? [error] : [new Error(String(error))]
  }
}

function addApiVersion(params: RequestParams, v: string) {
  return {...params, apiVersion: v}
}

// The JSON-RPC messages received on `ws`. Errors when the socket closes.
function messagesFrom(ws: WebSocket): Observable<JSONRpcMessage<unknown>> {
  return fromEvent<MessageEvent>(ws, 'message').pipe(
    filter((event) => event.data !== HEARTBEAT),
    mergeMap((event) => {
      const [err, msg] = tryParse(event.data)
      if (err) {
        console.warn('Unable to parse message: %s', err.message)
        return EMPTY
      }
      if (!msg || !msg.jsonrpc) {
        console.warn('Received empty or non-jsonrpc message: %s', msg)
        return EMPTY
      }
      return of(msg)
    }),
    mergeWith(errorOnClose(ws)),
  )
}

// A socket with its messages, parsed once and shared by every request on it.
// Replies are read from the socket a request was sent on, so a request never
// listens on (or opens) a different socket than the one it used.
interface Connection {
  ws: WebSocket
  messages$: Observable<JSONRpcMessage<unknown>>
}

/**
 * @public
 */
export interface BifurClientOptions {
  token$?: Observable<string | null>
  getNextRequestId?: () => string
}

/**
 * Create a Bifur client
 *
 * @param connection$ - An observable of open WebSocket connections. The client
 *   uses the latest socket until that socket closes. A socket that isn't open
 *   when it is emitted, or that closes later, errors the client's connection
 *   with a `WebSocketError` of type `CONNECTION_CLOSED`, so subscribers can
 *   reconnect.
 * @param options - Options for the client
 * @returns A Bifur client
 * @public
 */
export const createClient = (
  connection$: Observable<WebSocket>,
  options: BifurClientOptions = {},
): BifurClient => {
  const {token$, getNextRequestId = defaultGetNextRequestId} = options
  const [heartbeats$, responses$] = partition(
    connection$.pipe(switchMap((connection) => fromEvent<MessageEvent>(connection, 'message'))),
    (event) => event.data === HEARTBEAT,
  )

  const authedConnection$: Observable<Connection> = connection$.pipe(
    switchMap((ws) => {
      if (ws.readyState !== READY_STATE_OPEN) {
        return throwError(() => closedError())
      }
      const connection: Connection = {ws, messages$: messagesFrom(ws).pipe(share())}
      const authorized$ = token$
        ? token$.pipe(
            distinctUntilChanged(),
            switchMap((token) =>
              token
                ? call(connection, 'authorization', {authorization: `Bearer ${token}`}).pipe(
                    take(1),
                    map(() => connection),
                  )
                : of(connection),
            ),
          )
        : of(connection)
      // Error on close, so the share resets instead of replaying the closed
      // socket, and `heartbeats` errors with the close code. Listened for
      // before anything else on the socket (the `authorization` request
      // starts reading its messages), so `heartbeats` errors before any
      // request or subscription on it does, and a consumer can stop those when
      // the connection errors.
      return errorOnClose(ws).pipe(mergeWith(authorized$))
    }),
    share({
      connector: () => new ReplaySubject<Connection>(1),
      resetOnError: true,
      resetOnComplete: true,
      resetOnRefCountZero: true,
    }),
  )

  function call<T>(
    {ws, messages$}: Connection,
    method: string,
    params: RequestParams = {},
  ): Observable<T> {
    const requestId = getNextRequestId()
    return merge(
      messages$.pipe(
        filter((rpcResult) => rpcResult.id === requestId),
        map((rpcResult) => rpcResult.result as T),
      ),
      defer(() => {
        // `send` on a socket that isn't open throws (CONNECTING) or drops the
        // frame (CLOSING, CLOSED), and no reply would ever arrive
        if (ws.readyState !== READY_STATE_OPEN) {
          return throwError(
            () =>
              new WebSocketError(
                `Cannot call ${method}: WebSocket is not open`,
                'CONNECTION_CLOSED',
              ),
          )
        }
        ws.send(formatRequest(method, params, requestId))
        return EMPTY
      }),
    )
  }

  // Will call the rpc method and return an observable that emits the first reply and then ends
  // Requests and subscriptions stay subscribed to the connection until they
  // end, so it isn't closed while they still wait for messages on it.
  // `exhaustMap` keeps a re-authorized socket from sending a request again.
  function requestMethod<T>(method: RequestMethod, params?: RequestParams) {
    return authedConnection$.pipe(
      exhaustMap((connection) => call<T>(connection, method, params).pipe(take(1))),
      take(1),
    )
  }

  // Will call the rpc method with the '_subscribe' suffix and return an observable of all received messages and
  // keeps the subscription open forever/until unsubscribe
  function requestSubscribe(method: SubscribeMethods, params?: RequestParams) {
    return authedConnection$.pipe(
      exhaustMap(({ws, messages$}) =>
        call<string>({ws, messages$}, `${method}_subscribe`, params).pipe(
          take(1),
          mergeMap((subscriptionId) =>
            messages$.pipe(
              filter(
                (message) =>
                  message.method === `${method}_subscription` &&
                  message.params['subscription'] === subscriptionId,
              ),
              map((message) => message.params['result']),
              finalize(() => {
                if (ws.readyState === READY_STATE_OPEN) {
                  ws.send(
                    formatRequest(`${method}_unsubscribe`, {subscriptionId}, getNextRequestId()),
                  )
                }
              }),
            ),
          ),
        ),
      ),
    )
  }

  return {
    // heartbeat$ is a stream of date objects representing when the "last message was received"
    // it will keep the connection open until it is unsubscribed and can therefore be used to keep connection alive
    // between requests
    heartbeats: merge(authedConnection$, heartbeats$, responses$).pipe(map(() => new Date())),

    listen: (method: SubscribeMethods, params?: RequestParams) => requestSubscribe(method, params),

    request: (method: RequestMethod, params?: RequestParams) => requestMethod(method, params),
  }
}
