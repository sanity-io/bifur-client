import {Observable} from 'rxjs'

import type {WebSocketLike} from './types'

export const CLOSE_CODE_NORMAL = 1000
export const CLOSE_REASON = 'WebSockets connection closed by client'

/**
 * Emitted when the socket errors or closes, and when a request is made on a
 * socket that is no longer open. `code` and `reason` describe the close,
 * whichever side closed it (for example `1000` when `auth` drops the token),
 * and are `undefined` for a connection error.
 *
 * @public
 */
export class WebSocketError extends Error {
  type: 'CONNECTION_ERROR' | 'CONNECTION_CLOSED'
  code: number | undefined
  reason: string | undefined
  constructor(
    message: string,
    type: 'CONNECTION_ERROR' | 'CONNECTION_CLOSED',
    code?: number,
    reason?: string,
  ) {
    super(message)
    this.name = 'WebSocketError'
    this.type = type
    this.code = code
    this.reason = reason
  }
}

/**
 * Emitted when the server replies to a request with a JSON-RPC error, for
 * example when it rejects an `authorization` request. `code` is the JSON-RPC
 * error code (see `ERROR_CODES`).
 *
 * @public
 */
export class RpcError extends Error {
  code: number
  data: unknown
  constructor(message: string, code: number, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
}

/**
 * Closes the socket, but never mid-handshake — that's what makes browsers log
 * "WebSocket is closed before the connection is established". A CONNECTING
 * socket gets its close deferred to `onopen`, and a failed handshake needs no
 * close at all.
 */
function closeSocket(ws: WebSocketLike): void {
  if (ws.readyState === ws.CONNECTING) {
    ws.onopen = () => ws.close(CLOSE_CODE_NORMAL, CLOSE_REASON)
  } else if (ws.readyState === ws.OPEN) {
    ws.close(CLOSE_CODE_NORMAL, CLOSE_REASON)
  }
}

function detachHandlersAndClose(ws: WebSocketLike): void {
  ws.onopen = null
  ws.onerror = null
  ws.onclose = null
  closeSocket(ws)
}

export function createConnect<T extends WebSocketLike>(
  getWebsocketInstance: (url: string, protocols?: string | string[]) => T,
) {
  return (url: string) => {
    return new Observable<T>((subscriber) => {
      const ws = getWebsocketInstance(url)

      const onOpen: WebSocketLike['onopen'] = () => {
        subscriber.next(ws)
      }

      const onError: WebSocketLike['onerror'] = () => {
        subscriber.error(new WebSocketError('WebSocket connection error', 'CONNECTION_ERROR'))
      }

      const onClose: WebSocketLike['onclose'] = (ev) => {
        subscriber.error(
          new WebSocketError(
            'WebSocket connection closed',
            'CONNECTION_CLOSED',
            ev.code,
            ev.reason,
          ),
        )
      }

      ws.onopen = onOpen
      ws.onclose = onClose
      ws.onerror = onError

      return () => {
        detachHandlersAndClose(ws)
      }
    })
  }
}
