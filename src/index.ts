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
      // `share` so it doesn't wait on the disconnect tick below.
      takeUntil(isEventTargetLike(ourGlobal) ? fromEvent(ourGlobal, 'beforeunload') : NEVER),
      // One shared connection for all subscribers. Disconnect one tick after
      // the last unsubscribe, on the same task queue React flushes effects on
      // — same-queue tasks run in order, so a pending effect resubscribe
      // (react-rx's `useObservable` unsubscribes during render, resubscribes
      // from an effect) always beats the disconnect.
      share({
        connector: () => new ReplaySubject<WebSocket>(1),
        resetOnError: true,
        resetOnComplete: true,
        resetOnRefCountZero: nextTask,
      }),
    ),
    {token$},
  )
}

/**
 * Emits one tick on the task queue React's scheduler uses for passive effects
 * (`setImmediate` in Node and jsdom, `MessageChannel` in browsers). Tasks on
 * one queue run in order, so a tick requested after React schedules an effect
 * flush always runs after that flush. Falls back to a plain timer where
 * neither exists.
 */
function nextTask(): Observable<number> {
  const {setImmediate: schedule, clearImmediate: cancel} = globalThis as {
    setImmediate?: (callback: () => void) => unknown
    clearImmediate?: (handle: unknown) => void
  }
  if (schedule && cancel) {
    return new Observable((subscriber) => {
      const handle = schedule(() => subscriber.next(0))
      return () => cancel(handle)
    })
  }
  if (typeof MessageChannel === 'function') {
    return new Observable((subscriber) => {
      const {port1, port2} = new MessageChannel()
      port1.onmessage = () => subscriber.next(0)
      port2.postMessage(null)
      return () => {
        port1.onmessage = null
        port1.close()
        port2.close()
      }
    })
  }
  return timer(0)
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
