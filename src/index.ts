import {Observable, type ObservableInput, of, ReplaySubject, share, throwError, timer} from 'rxjs'

import {createClient, type BifurClientOptions, type Auth} from './createClient'
import {createConnect, RpcError, WebSocketError} from './createConnect'
import {timeoutFirstWith} from './operators'
import type {BifurClient, SanityClientLike} from './types'

/**
 * @public
 */
export interface FromUrlOptions {
  timeout?: number
  /**
   * The connection's credentials, as a stream of promises. See
   * {@link BifurClientOptions.auth}.
   */
  auth?: Observable<Promise<Auth | undefined>>
  /**
   * How long, in milliseconds, the shared connection stays open after its
   * last subscriber leaves. Defaults to `0`: the socket closes as soon as
   * nothing uses it, so no timer is left pending. A delay reuses the socket
   * across short gaps between subscribers, for example when React unmounts
   * one component and mounts another that uses the same client. Sanity
   * Studio passes 5000, because it saw gaps of 96–250 ms between subscribers
   * while booting (https://github.com/sanity-io/sanity/pull/14152).
   *
   * `Infinity`, or any delay longer than a timer supports (about 24.8 days),
   * keeps the socket open after the last subscriber leaves.
   *
   * To decide each time, pass a function. It's called whenever the last
   * subscriber leaves, and the socket closes when the observable it returns
   * emits. If a subscriber comes back first, the observable is unsubscribed
   * and the socket is kept. For example, wait 5 seconds, but close at once if
   * the page is hidden:
   *
   * ```ts
   * idleTimeout: () => (document.visibilityState === 'hidden' ? of(0) : timer(5_000))
   * ```
   */
  idleTimeout?: number | (() => ObservableInput<unknown>)
}

const id = <T>(arg: T): T => arg

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

export type {SubscribeMethods, RequestMethod, RequestParams} from './types'
export {ERROR_CODES} from './errorCodes'
export {type BifurClient, type BifurClientOptions, type Auth}
export {createClient, type SanityClientLike}
export {RpcError, WebSocketError}

/**
 * Create a BifurClient from a WebSocket URL
 *
 * @param url - The URL to connect to
 * @param options - Options for the client
 * @returns A Bifur client instance
 * @public
 */
export function fromUrl(url: string, options: FromUrlOptions = {}): BifurClient {
  const {timeout, auth, idleTimeout = 0} = options

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
      // One shared connection for all subscribers, closed `idleTimeout`
      // after the last one leaves
      share({
        connector: () => new ReplaySubject<WebSocket>(1),
        resetOnError: true,
        resetOnComplete: true,
        resetOnRefCountZero: closeWhenIdle(idleTimeout),
      }),
    ),
    {auth},
  )
}

/**
 * Options for {@link fromSanityClient}: the same as for {@link fromUrl}.
 * Without `auth`, the connection is authorized with the client's token, if it
 * has one.
 *
 * @public
 */
export type FromSanityClientOptions = FromUrlOptions

/**
 * Create a Bifur client from a `@sanity/client`-like instance
 *
 * @param client - A `@sanity/client`-like instance
 * @param options - Options for the connection
 * @returns A Bifur client instance
 * @public
 */
export function fromSanityClient(
  client: SanityClientLike,
  options: FromSanityClientOptions = {},
): BifurClient {
  const {dataset, token} = client.config()
  return fromUrl(client.getUrl(`/socket/${dataset}`).replace(/^http/, 'ws'), {
    ...options,
    auth: options.auth ?? (token ? of(Promise.resolve({token})) : undefined),
  })
}
