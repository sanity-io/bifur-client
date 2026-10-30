# @sanity/bifur-client

A WebSocket client for Sanity's Bifur real-time service. Communicates over JSON-RPC 2.0 and returns RxJS Observables.

## Installation

```sh
npm install @sanity/bifur-client
```

## Usage

### From a `@sanity/client` instance

The simplest way to get started if you already use `@sanity/client`:

```ts
import {fromSanityClient} from '@sanity/bifur-client'
import {createClient} from '@sanity/client'

const sanityClient = createClient({
  projectId: 'your-project-id',
  dataset: 'production',
  token: 'your-token',
})

const bifur = fromSanityClient(sanityClient)
```

`fromSanityClient` accepts the same options as `fromUrl` below, as a second argument. Without `auth`, the connection is authorized with the client's token, if it has one.

### From a WebSocket URL

Connect directly to a Bifur WebSocket endpoint:

```ts
import {fromUrl, type Auth} from '@sanity/bifur-client'
import {BehaviorSubject} from 'rxjs'

const auth = new BehaviorSubject<Promise<Auth | undefined>>(Promise.resolve({token: 'your-token'}))

const bifur = fromUrl('wss://example.sanity.io/socket/production', {
  timeout: 10_000,
  auth,
})

// On renewal. Requests wait until the socket is authorized with the new token.
auth.next(renewToken().then((token) => ({token})))
```

#### Authentication

Each promise from `auth` resolves to one of:

- `{token: string}`: the socket is authorized with the token.
- `{withCredentials: true}`: no token is sent. The browser sends cookies with the WebSocket handshake.
- `undefined`: no credentials.

A rejected promise errors the connection. Every new request then fails the same way until `auth` emits a new promise, so don't retry before the credentials are renewed. When the credentials switch from a token to cookies or none, for example on logout, the socket is closed. This happens even while the socket waits out `idleTimeout`. Requests waiting at that moment, or made before the socket has closed, fail with a `WebSocketError` of type `CONNECTION_CLOSED`, and the next request connects without the token.

`token$` was removed in 3.0. To migrate, wrap it:

```ts
import {map} from 'rxjs'

fromUrl(url, {auth: token$.pipe(map((token) => Promise.resolve(token ? {token} : undefined)))})
```

#### Options

| Option        | Type                                     | Description                                                                                                                                                                                                  |
| ------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `timeout`     | `number`                                 | Milliseconds to wait before timing out the initial connection                                                                                                                                                |
| `auth`        | `Observable<Promise<Auth \| undefined>>` | Stream of promises that resolve to the credentials. Emit a new promise when a renewal starts; requests wait for it. Must replay its latest value to new subscribers, like a `BehaviorSubject`.               |
| `idleTimeout` | `number \| (() => ObservableInput)`      | Milliseconds to keep the socket open after the last subscriber leaves. Defaults to `0` (closes immediately). Pass a function to decide each time: the socket closes when the observable it returns emits.    |
| `closeOn`     | `Observable<unknown>`                    | Closes the connection when it emits, without waiting for `idleTimeout`. Everything using the connection errors with `CONNECTION_CLOSED`, and the next subscriber reconnects. Must not replay its last value. |

#### Closing the connection

Pass `closeOn` to close the connection when an observable emits, even while it's in use, without waiting for `idleTimeout`. Everything still using the connection errors with a `WebSocketError` of type `CONNECTION_CLOSED`, and the next subscriber opens a new socket.

`closeOn` must not replay its last value. It's subscribed once per connection, so a `BehaviorSubject` or `ReplaySubject` closes every new connection as soon as it opens.

For example, close the socket when the page enters the back/forward cache. An open socket would otherwise either be closed by the browser, which logs an error, or keep the page out of the cache:

```ts
import {filter, fromEvent} from 'rxjs'

const enteredBackForwardCache$ = fromEvent<PageTransitionEvent>(window, 'pagehide').pipe(
  filter((event) => event.persisted),
)

const bifur = fromUrl(url, {auth, idleTimeout: 5_000, closeOn: enteredBackForwardCache$})
```

Anything that uses the client after `closeOn` has emitted opens a new connection, so make sure nothing does when you close for the back/forward cache. Before the socket closes, each active `listen()` sends its `_unsubscribe` request; nothing else is sent. Requests made while a page is being left, such as a "goodbye" message, can't be relied on to reach the server: they're lost whenever the page is killed or the network drops.

### Presence example

Subscribe to presence events with `listen()`, and send requests with `request()`:

```ts
// Subscribe to presence events
bifur.listen('presence').subscribe((event) => {
  console.log(event.type, event) // 'rollCall', 'state', or 'disconnect'
})

// Respond to roll calls
bifur.request('presence_rollcall', {session: sessionId})

// Announce your location
bifur.request('presence_announce', {
  data: {sessionId, locations: [{documentId: 'my-doc', path: 'title'}]},
})

// Disconnect
bifur.request('presence_disconnect', {session: sessionId})
```

### Heartbeats

`heartbeats` is an Observable that emits a `Date` each time a message (including heartbeat pings) is received. Subscribing to it keeps the connection alive between requests:

```ts
bifur.heartbeats.subscribe((timestamp) => {
  console.log('Last activity:', timestamp)
})
```

When the socket closes while `heartbeats` is subscribed, it errors with a `WebSocketError` of type `CONNECTION_CLOSED` that carries the close `code` and `reason`. Subscribe again to open a new connection.

### Request and subscribe methods

**Request methods:** `presence_rollcall`, `presence_announce`, `presence_disconnect`, `authorization`

**Subscribe methods:** `presence`, `authorization`

### Error codes

The connection-level codes arrive as `WebSocketError.code`, the close code. The JSON-RPC codes arrive as `RpcError.code`, when the server replies to a request with an error.

```ts
import {ERROR_CODES} from '@sanity/bifur-client'

// Connection-level
ERROR_CODES.BAD_REQUEST // 4000
ERROR_CODES.UNAUTHORIZED // 4001
ERROR_CODES.NOT_FOUND // 4004

// Application-level (JSON-RPC)
ERROR_CODES.INVALID_REQUEST // -32600
ERROR_CODES.METHOD_NOT_FOUND // -32601
ERROR_CODES.INVALID_PARAMS // -32602
ERROR_CODES.SUBSCRIPTION_NOT_FOUND // -32602
ERROR_CODES.PARSE_ERROR // -32700
```

## License

MIT - See LICENSE
