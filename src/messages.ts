import {
  filter,
  map,
  mergeMap,
  mergeMapTo,
  share,
  shareReplay,
  switchMap,
  take,
} from 'rxjs/operators'

import {
  defer,
  EMPTY,
  fromEvent,
  merge,
  Observable,
  of,
  partition,
  race,
  throwError,
  timer,
} from 'rxjs'

import {customAlphabet} from 'nanoid'
import {fromUrl} from './index'

// at 1000 IDs per second ~4 million years needed in order to have a 1% probability of at least one collision.
// => https://zelark.github.io/nano-id-cc/
const getNextRequestId = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-',
  20,
)

const HEARTBEAT = '♥'

type RequestMethod = 'query' | 'mutate' | 'presence_rollcall'
type StreamMethod = 'presence' | 'listen'

type RequestParams = Record<string, any>

type JSONRpcMessage<T> = {
  jsonrpc: string
  id: string
  method: string
  params: RequestParams
  result: T
}

interface BifurClient {
  heartbeat$: Observable<Date>
  request: <T>(method: RequestMethod, params?: RequestParams) => Observable<T>
  stream: <T>(method: StreamMethod, params?: RequestParams) => Observable<T>
}

function formatRequest(method: string, params: RequestParams, id: string) {
  return JSON.stringify({
    jsonrpc: '2.0',
    method,
    params,
    id,
  })
}

function tryParse<T>(input: string): [Error] | [null, T] {
  try {
    return [null, JSON.parse(input)]
  } catch (error) {
    return [error]
  }
}

const CONNECT_TIMEOUT_MS = 5000

// Operator that will time out using <withObservable> if <due> time passes before receiving the first value
const timeoutOneWith = <T>(due: number, withObservable: Observable<any>) => {
  return (input$: Observable<T>): Observable<T> => {
    return race(input$, timer(due).pipe(mergeMapTo(withObservable)))
  }
}

function addApiVersion(params: RequestParams, v: string) {
  return {...params, apiVersion: v}
}

export const createClient = (url: string): BifurClient => {
  const connection$ = fromUrl(url).pipe(
    timeoutOneWith(
      CONNECT_TIMEOUT_MS,
      throwError(
        new Error(
          `Timeout after ${CONNECT_TIMEOUT_MS} while establishing WebSockets connection`,
        ),
      ),
    ),
    shareReplay({refCount: true}),
  )

  const [heartbeats$, responses$] = partition(
    connection$.pipe(
      switchMap(connection => fromEvent<MessageEvent>(connection, 'message')),
    ),
    event => event.data === HEARTBEAT,
  )

  const parsedResponses$ = responses$.pipe(
    mergeMap(response => {
      const [err, msg] = tryParse<JSONRpcMessage<any>>(response.data)
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
    share(),
  )

  function call<T>(method: string, params: RequestParams): Observable<T> {
    const requestId = getNextRequestId()
    return connection$.pipe(
      take(1),
      mergeMap(ws => {
        return merge(
          parsedResponses$.pipe(
            filter(rpcResult => rpcResult.id === requestId),
            map(rpcResult => rpcResult.result),
          ),
          defer(() => {
            ws.send(
              formatRequest(method, addApiVersion(params, 'v1'), requestId),
            )
            return EMPTY
          }),
        )
      }),
    )
  }

  // Will call the rpc method and return the first reply
  function request<T>(method: RequestMethod, params: RequestParams = {}) {
    return call<T>(method, params).pipe(take(1))
  }

  function stream<T>(method: StreamMethod, params: RequestParams = {}) {
    return call<string>(`${method}_subscribe`, params).pipe(
      take(1),
      mergeMap(subscriptionId =>
        parsedResponses$.pipe(
          filter(
            message =>
              message.method === `${method}_subscription` &&
              message.params.subscription === subscriptionId,
          ),
          map(message => message.params.result),
        ),
      ),
    )
  }

  const heartbeat$ = merge(heartbeats$, responses$).pipe(map(() => new Date()))

  return {
    heartbeat$,
    request,
    stream,
  }
}
