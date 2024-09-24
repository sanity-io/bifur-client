import type {BifurClient, SanityClientLike} from './types'
import {createClient, type BifurClientOptions} from './createClient'
import {createConnect} from './createConnect'
import {timeoutFirstWith} from './operators'
import {shareReplay, takeUntil} from 'rxjs/operators'
import {throwError, fromEvent, Observable, of} from 'rxjs'

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
export {BifurClient, type BifurClientOptions}
export { createClient, type SanityClientLike }

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

  const connect = createConnect<WebSocket>(
    (url: string, protocols?: string | string[]) =>
      new window.WebSocket(url, protocols),
  )

  return createClient(
    connect(url).pipe(
      timeout
        ? timeoutFirstWith(
            timeout,
            throwError(() =>
              new Error(
                `Timeout after ${timeout} while establishing WebSockets connection`,
              ),
            ),
          )
        : id,
      shareReplay({refCount: true}),
      takeUntil(fromEvent(window, 'beforeunload')), // ensure graceful disconnect
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
