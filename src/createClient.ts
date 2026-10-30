import {customAlphabet} from 'nanoid'
import {
  concat,
  defer,
  distinctUntilChanged,
  EMPTY,
  exhaustMap,
  filter,
  finalize,
  from,
  fromEvent,
  map,
  merge,
  mergeMap,
  mergeWith,
  Observable,
  type ObservableInput,
  of,
  ReplaySubject,
  share,
  shareReplay,
  switchAll,
  switchMap,
  take,
  throwError,
  timer,
} from 'rxjs'

import {RpcError, WebSocketError} from './createConnect'
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

// `WebSocket` readyState values, fixed by the WebSocket spec. Compared as
// literals so a socket object without the readyState constants still works.
const READY_STATE_CONNECTING = 0
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

// An `authorization` request sent on a socket, and its reply
interface SentAuthorization {
  ws: WebSocket
  token: string
  reply$: Observable<unknown>
}

const CLOSE_CODE_NORMAL = 1000
// Shown as the close `reason` on the `WebSocketError` that waiting requests get
const CLOSE_REASON_TOKEN_DROPPED = 'Credentials no longer include a token'

/**
 * Authentication for the connection: a token, or cookies. With
 * `{withCredentials: true}`, the client sends no token, and the browser sends
 * cookies with the WebSocket handshake. A changed cookie session isn't applied
 * to a socket that is already open, and switching from a token to cookies
 * closes the socket, so the next one connects without the token. Accepted so
 * the same auth stream can be passed to `@sanity/client`.
 *
 * @public
 */
export type Auth = {token: string} | {withCredentials: true}

/**
 * @public
 */
export interface BifurClientOptions {
  /**
   * The connection's credentials, as a stream of promises. Emit a promise
   * when a renewal starts, and resolve it with the new credentials: requests
   * wait until the open socket is authorized with them, without
   * reconnecting, and are then sent. A promise that resolves to `undefined`
   * sends no credentials. A promise that never settles keeps requests
   * waiting. Credentials without a token that come after a token will close
   * the socket. Requests pending at that moment, or made before the socket has
   * closed, will fail with `WebSocketError` with type `CONNECTION_CLOSED`,
   * and the following requests will connect without a token.
   * A renewed token is similarly sent to an idle socket (i.e. while waiting
   * for idleTimeout).
   *
   * A rejected auth promise errors the connection with the promise's own error.
   * Until `auth` emits a new promise, every new request opens a socket, gets
   * the same rejection and closes it again, so don't retry before the
   * credentials are renewed. The client only handles a promise's rejection
   * while a socket is open; add your own `.catch` to avoid unhandled
   * rejections.
   *
   * Must replay the latest emission to new subscribers, like a
   * `BehaviorSubject`. With a plain `Subject`, requests on a new socket wait
   * until `auth` emits again.
   */
  auth?: Observable<Promise<Auth | undefined>>
  /**
   * How long, in milliseconds, the connection stays open after its last
   * subscriber leaves. See `FromUrlOptions.idleTimeout`. Defaults to `0`.
   */
  idleTimeout?: number | (() => ObservableInput<unknown>)
  getNextRequestId?: () => string
}

// The longest delay `setTimeout` supports. Longer ones fire after about 1 ms.
const MAX_TIMER_DELAY = 2 ** 31 - 1

// When to close the shared connection once its last subscriber has left, in
// the form `share`'s `resetOnRefCountZero` takes
function closeWhenIdle(
  idleTimeout: number | (() => ObservableInput<unknown>),
): boolean | (() => ObservableInput<unknown>) {
  if (typeof idleTimeout === 'function') return idleTimeout
  if (idleTimeout > MAX_TIMER_DELAY) return false
  return idleTimeout > 0 ? () => timer(idleTimeout) : true
}

function isConnection(connection: Connection | null): connection is Connection {
  return connection !== null
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
  const {auth, idleTimeout = 0, getNextRequestId = defaultGetNextRequestId} = options
  // One stream per credential change: `null` while a renewal is pending, then
  // the credentials
  const credentials$: Observable<Observable<Auth | undefined | null>> | undefined = auth?.pipe(
    map((promise) => concat(of(null), from(promise))),
  )
  // The last authorization sent, and the socket it was sent on. The
  // connection below lasts as long as its socket, but a caller may pass a
  // shared `connection$` that hands the same open socket to a new
  // subscription, so this is kept outside it: the socket's token is still
  // known then. Only one socket is current at a time, so one is enough. The
  // reply is shared without `refCount`, so a renewal that switches away from
  // a pending authorization doesn't cancel it, and one that resolves to the
  // same token waits for that same reply.
  let lastAuthorization: SentAuthorization | undefined

  // The one connection all users share: the socket, authorized with the
  // current credentials. Emits `null` while a credential renewal is pending,
  // so requests wait for it. The share keeps it subscribed until
  // `idleTimeout` after the last user leaves, so credential changes reach an
  // idle socket too: a renewal is sent to it, and a dropped token closes it.
  const authedConnection$: Observable<Connection | null> = connection$.pipe(
    switchMap((ws) => {
      if (ws.readyState === READY_STATE_CONNECTING) {
        return throwError(() => closedError())
      }
      // A closing socket errors once `close` fires, with its code, rather
      // than right away: an immediate error would let a consumer that retries
      // without a delay get the same closing socket again, synchronously
      if (ws.readyState !== READY_STATE_OPEN) {
        return errorOnClose(ws)
      }
      const connection: Connection = {ws, messages$: messagesFrom(ws).pipe(share())}
      const authorize = (credentials: Auth | undefined): Observable<Connection | null> => {
        const token = credentials && 'token' in credentials ? credentials.token : undefined
        // Only an authorization sent on this socket counts
        let sent = lastAuthorization?.ws === ws ? lastAuthorization : undefined
        if (!token) {
          if (!sent) {
            return of(connection)
          }
          // There's no call that takes an authorization back, so close the
          // socket: the next connection starts without the token. Requests
          // wait, then error with the close code once `close` fires.
          return defer(() => {
            ws.close(CLOSE_CODE_NORMAL, CLOSE_REASON_TOKEN_DROPPED)
            return of(null)
          })
        }
        if (sent?.token !== token) {
          sent = lastAuthorization = {
            ws,
            token,
            reply$: call(connection, 'authorization', {authorization: `Bearer ${token}`}).pipe(
              take(1),
              shareReplay(1),
            ),
          }
        }
        return sent.reply$.pipe(map(() => connection))
      }
      const authorized$: Observable<Connection | null> = credentials$
        ? credentials$.pipe(
            switchAll(),
            switchMap((credentials) => (credentials === null ? of(null) : authorize(credentials))),
          )
        : of(connection)
      // Error on close, so the share resets instead of replaying the closed
      // socket, and `heartbeats` errors with the close code. Listened for
      // before anything else on the socket (the `authorization` request
      // starts reading its messages), so `heartbeats` errors before any
      // request or subscription that subscribed after it, and a consumer can
      // stop those when the connection errors.
      return errorOnClose(ws).pipe(mergeWith(authorized$))
    }),
    share({
      connector: () => new ReplaySubject<Connection | null>(1),
      resetOnError: true,
      resetOnComplete: true,
      resetOnRefCountZero: closeWhenIdle(idleTimeout),
    }),
  )

  const connected$ = authedConnection$.pipe(filter(isConnection))

  function call<T>(
    {ws, messages$}: Connection,
    method: string,
    params: RequestParams = {},
  ): Observable<T> {
    const requestId = getNextRequestId()
    return merge(
      messages$.pipe(
        filter((rpcResult) => rpcResult.id === requestId),
        // An error reply fails the request, rather than emitting `undefined`
        mergeMap((rpcResult) =>
          rpcResult.error
            ? throwError(
                () =>
                  new RpcError(
                    rpcResult.error!.message,
                    rpcResult.error!.code,
                    rpcResult.error!.data,
                  ),
              )
            : of(rpcResult.result as T),
        ),
      ),
      defer(() => {
        // `send` on a socket that isn't open throws (CONNECTING) or drops the
        // frame (CLOSING, CLOSED), and no reply would ever arrive
        if (ws.readyState === READY_STATE_CONNECTING) {
          return throwError(
            () =>
              new WebSocketError(
                `Cannot call ${method}: WebSocket is not open`,
                'CONNECTION_CLOSED',
              ),
          )
        }
        // A closing or closed socket: send nothing. `messages$` errors with
        // the close code once `close` fires, or right away if it already has.
        if (ws.readyState !== READY_STATE_OPEN) {
          return EMPTY
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
    return connected$.pipe(
      exhaustMap((connection) => call<T>(connection, method, params).pipe(take(1))),
      take(1),
    )
  }

  // Will call the rpc method with the '_subscribe' suffix and return an observable of all received messages and
  // keeps the subscription open forever/until unsubscribe
  function requestSubscribe(method: SubscribeMethods, params?: RequestParams) {
    return connected$.pipe(
      exhaustMap((connection) =>
        call<string>(connection, `${method}_subscribe`, params).pipe(
          take(1),
          mergeMap((subscriptionId) =>
            connection.messages$.pipe(
              filter(
                (message) =>
                  message.method === `${method}_subscription` &&
                  message.params['subscription'] === subscriptionId,
              ),
              map((message) => message.params['result']),
              finalize(() => {
                if (connection.ws.readyState === READY_STATE_OPEN) {
                  connection.ws.send(
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
    // A `Date` when the connection is (re)authorized and whenever a message
    // arrives, heartbeats included. Keeps the connection open while
    // subscribed, so it can keep the socket alive between requests.
    heartbeats: merge(
      connected$,
      connected$.pipe(
        distinctUntilChanged((previous, current) => previous.ws === current.ws),
        switchMap(({ws}) => fromEvent<MessageEvent>(ws, 'message')),
      ),
    ).pipe(map(() => new Date())),

    listen: (method: SubscribeMethods, params?: RequestParams) => requestSubscribe(method, params),

    request: (method: RequestMethod, params?: RequestParams) => requestMethod(method, params),
  }
}
