import {Observable, of, ReplaySubject, share, throwError, timer} from 'rxjs'

import {createClient, type BifurClientOptions} from './createClient'
import {createConnect, WebSocketError} from './createConnect'
import {timeoutFirstWith} from './operators'
import type {BifurClient, SanityClientLike} from './types'

/**
 * @public
 */
export interface FromUrlOptions {
  timeout?: number
  token$?: Observable<string | null>
  /**
   * How long, in milliseconds, the shared connection stays open after its
   * last subscriber leaves. Defaults to `0`: the socket closes as soon as
   * nothing uses it, so no timer is left pending. A delay reuses the socket
   * across short gaps between subscribers, for example when React unmounts
   * one component and mounts another that uses the same client. The studio
   * uses 5000: it measured gaps of 96–250ms under boot load
   * (https://github.com/sanity-io/sanity/pull/14152).
   */
  disconnectDelay?: number
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
  const {timeout, token$, disconnectDelay = 0} = options

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
      // One shared connection for all subscribers, closed `disconnectDelay`
      // after the last one leaves
      share({
        connector: () => new ReplaySubject<WebSocket>(1),
        resetOnError: true,
        resetOnComplete: true,
        resetOnRefCountZero: disconnectDelay > 0 ? () => timer(disconnectDelay) : true,
      }),
    ),
    {token$},
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
