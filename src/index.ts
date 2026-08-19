import {
  fromEvent,
  NEVER,
  Observable,
  of,
  ReplaySubject,
  share,
  takeUntil,
  throwError,
  timer,
} from 'rxjs'

import {createClient, type BifurClientOptions} from './createClient'
import {createConnect, WebSocketError} from './createConnect'
import {timeoutFirstWith} from './operators'
import type {BifurClient, SanityClientLike, EventTargetLike} from './types'

/**
 * @public
 */
export interface FromUrlOptions {
  timeout?: number
  token$?: Observable<string | null>
}

const id = <T>(arg: T): T => arg

/**
 * How long the shared connection stays open after its last subscriber leaves.
 * Matches the studio's `LISTENER_RESET_DELAY` convention (5s).
 */
const DISCONNECT_GRACE_PERIOD = 5_000

export type {SubscribeMethods, RequestMethod, RequestParams} from './types'
export {ERROR_CODES} from './errorCodes'
export {type BifurClient, type BifurClientOptions}
export {createClient, type SanityClientLike}
export {WebSocketError}

/**
 * Create a BifurClient from a WebSocket URL
 *
 * @param url - The URL to connect to
 * @param options - Options for the client
 * @returns A Bifur client instance
 * @public
 */
export function fromUrl(url: string, options: FromUrlOptions = {}): BifurClient {
  const {timeout, token$} = options

  const ourGlobal: unknown = globalThis
  const connect = createConnect<WebSocket>(
    (url: string, protocols?: string | string[]) => new globalThis.WebSocket(url, protocols),
  )

  return createClient(
    connect(url).pipe(
      timeout
        ? timeoutFirstWith(
            timeout,
            throwError(
              () => new Error(`Timeout after ${timeout} while establishing WebSockets connection`),
            ),
          )
        : id,
      // Close the socket right away when the page unloads — placed before the
      // `share` so it doesn't wait on the disconnect grace below.
      takeUntil(isEventTargetLike(ourGlobal) ? fromEvent(ourGlobal, 'beforeunload') : NEVER),
      // One shared connection for all subscribers. Disconnect a wall-clock
      // grace period after the last unsubscribe, so momentary zero-subscriber
      // gaps (react-rx's `useObservable` unsubscribes during render and only
      // resubscribes from a passive effect) reuse the socket instead of
      // closing and reopening it. The grace must be wall-clock time, not a
      // task-queue tick: under boot load React's scheduler works in ~5ms
      // slices and re-posts its host callback, so the effect flush that
      // resubscribes completes an unbounded number of tasks after teardown —
      // measured at 96–250ms on real studio boots, where every fixed-tick
      // notifier (`timer(0)`, chained timers, `setImmediate`/`MessageChannel`)
      // still churned 2–3 sockets per boot. See
      // https://github.com/sanity-io/sanity/pull/14152 for the measurements.
      share({
        connector: () => new ReplaySubject<WebSocket>(1),
        resetOnError: true,
        resetOnComplete: true,
        resetOnRefCountZero: () => timer(DISCONNECT_GRACE_PERIOD),
      }),
    ),
    {token$},
  )
}

function isEventTargetLike(thing: unknown): thing is EventTargetLike {
  return (
    typeof thing === 'object' &&
    thing !== null &&
    'addEventListener' in thing &&
    typeof thing.addEventListener === 'function' &&
    'removeEventListener' in thing &&
    typeof thing.removeEventListener === 'function'
  )
}

/**
 * Create a Bifur client from a `@sanity/client`-like instance
 *
 * @param client - A `@sanity/client`-like instance
 * @returns A Bifur client instance
 * @public
 */
export function fromSanityClient(client: SanityClientLike): BifurClient {
  const {dataset, token} = client.config()
  return fromUrl(
    client.getUrl(`/socket/${dataset}`).replace(/^http/, 'ws'),
    token ? {token$: of(token)} : {},
  )
}
