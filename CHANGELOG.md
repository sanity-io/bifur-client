# @sanity/bifur-client

## 3.0.0

### Major Changes

- [#47](https://github.com/sanity-io/bifur-client/pull/47) [`988fe6d`](https://github.com/sanity-io/bifur-client/commit/988fe6dd7b10441bbaffc6735086197df33e1a01) Thanks [@bjoerge](https://github.com/bjoerge)! - Add an `auth` option to `createClient`, `fromUrl` and `fromSanityClient`: an observable of promises that resolve to the connection's credentials. A promise can resolve to `{token}`, to `{withCredentials: true}` for cookies, or to `undefined` for no credentials. With cookies, the client sends no token, and the browser sends the cookies with the WebSocket handshake. The observable must replay its latest emission to new subscribers, like a `BehaviorSubject`. Without `auth`, `fromSanityClient` still authorizes with the client's token, and it now accepts all the options `fromUrl` does.
  
  Emit a new promise when a token renewal starts. Requests wait until the promise resolves and the open socket is authorized with the new token, then they are sent, so requests made during a renewal use the new token. A rejected promise errors the connection, and every new request fails the same way until `auth` emits a new promise, so don't retry before the credentials are renewed. When the credentials switch from a token to cookies or none, for example on logout, the client closes the socket. Requests waiting at that moment, or made before the socket has closed, fail with a `WebSocketError` of type `CONNECTION_CLOSED`, and the next request opens a new socket without the token. A socket waiting out `idleTimeout` still follows `auth`: a renewed token is sent to it, and a dropped token closes it right away.
  
  ```ts
  const auth = new BehaviorSubject<Promise<Auth | undefined>>(Promise.resolve({token}))
  const client = fromUrl(url, {auth})
  
  // on renewal, with your own function that resolves to the new token
  auth.next(renewToken().then((token) => ({token})))
  ```
  
  `createClient` also takes the `idleTimeout` option now, the same as `fromUrl`.
  
  **Breaking:** `request()` and `listen()` now fail with an `RpcError`, which carries the JSON-RPC error `code`, when the server replies with an error. Before, they emitted `undefined`. A rejected `authorization` request therefore errors the connection instead of letting requests go out unauthorized.
  
  **Breaking:** `token$` is removed. Wrap an existing token observable to migrate:
  
  ```ts
  import {map} from 'rxjs'
  
  fromUrl(url, {auth: token$.pipe(map((token) => Promise.resolve(token ? {token} : undefined)))})
  ```
  
  After migrating, a `null` token that follows a token closes the socket, so the next request connects without it.

- [#46](https://github.com/sanity-io/bifur-client/pull/46) [`b77d428`](https://github.com/sanity-io/bifur-client/commit/b77d428416655c76d092ccbbe67d7f003f02232c) Thanks [@bjoerge](https://github.com/bjoerge)! - `fromUrl` and `fromSanityClient` now close the socket as soon as the last subscriber leaves. Before, they kept it open for 5 seconds, which left a timer pending and could keep a runtime such as Node.js from exiting. To keep the old behavior, pass the new `idleTimeout` option:
  
  ```ts
  fromUrl(url, {idleTimeout: 5_000})
  fromSanityClient(client, {idleTimeout: 5_000})
  ```
  
  A delay reuses the socket across short gaps between subscribers, for example when React unmounts one component and mounts another that uses the same client, or when react-rx's `useObservable` resubscribes from an effect after unsubscribing during render.
  
  To decide each time, pass a function instead of a number. It's called whenever the last subscriber leaves, and the socket closes when the observable it returns emits:
  
  ```ts
  fromUrl(url, {
    idleTimeout: () => (document.visibilityState === 'hidden' ? of(0) : timer(5_000)),
  })
  ```

### Minor Changes

- [#50](https://github.com/sanity-io/bifur-client/pull/50) [`2e4caa1`](https://github.com/sanity-io/bifur-client/commit/2e4caa1ac59f4cbc82a921a950c4e18bca69a885) Thanks [@bjoerge](https://github.com/bjoerge)! - Add a `closeOn` option to `fromUrl` and `fromSanityClient`. When the observable emits, the socket is closed (code 1000) without waiting for `idleTimeout`, even if it's still connecting. `heartbeats`, pending requests and active `listen()` subscriptions error with a `WebSocketError` of type `CONNECTION_CLOSED`, and the next subscriber opens a new socket. An emission while no connection is open does nothing. Nothing is sent to the server first: it drops the connection's subscriptions when the socket closes. The observable must not replay its last value, like a `BehaviorSubject` does: it's subscribed once per connection, so a replayed emission closes every new connection as soon as it opens.
  
  For example, close the socket when the page enters the back/forward cache. An open socket would otherwise either be closed by the browser, which logs an error, or keep the page out of the cache:
  
  ```ts
  const enteredBackForwardCache$ = fromEvent<PageTransitionEvent>(window, 'pagehide').pipe(
    filter((event) => event.persisted),
  )
  
  fromUrl(url, {auth, idleTimeout: 5_000, closeOn: enteredBackForwardCache$})
  ```
  
  Anything that uses the client after `closeOn` has emitted opens a new connection, so make sure nothing does when you close for the back/forward cache.

### Patch Changes

- [#45](https://github.com/sanity-io/bifur-client/pull/45) [`a303cae`](https://github.com/sanity-io/bifur-client/commit/a303cae0f4b467e18ad6c8ee55c3967f2d25e5b4) Thanks [@bjoerge](https://github.com/bjoerge)! - Fix requests being sent on a closed WebSocket.
  
  `fromUrl` closed the socket on `beforeunload`, but the page doesn't always leave after that event: it stays when an "unsaved changes" prompt is cancelled, and it can come back from the back/forward cache. Requests on such a page were then sent on the closed socket. The browser logged "WebSocket is already in CLOSING or CLOSED state", the requests never settled, and `heartbeats` kept reporting a live connection.
  
  - `fromUrl` no longer closes the socket on `beforeunload`. The browser closes it itself when the page is unloaded.
  - `request()` and `listen()` no longer send on a socket that isn't open. They error with a `WebSocketError` of type `CONNECTION_CLOSED` once it has closed.
  - When the socket closes while it's still in use, `heartbeats`, and any requests and subscriptions still waiting for a reply, error with a `WebSocketError` of type `CONNECTION_CLOSED` that carries the close `code` and `reason`. The next request opens a new socket. A close because the last subscriber left never causes this error.
  - `token$` is now subscribed on each new socket, once it is open, so it must replay its latest value to new subscribers (a `BehaviorSubject`, or `shareReplay`). This was already needed for the token to be used after a reconnect; it is now documented.

## 2.0.2

### Patch Changes

- [#38](https://github.com/sanity-io/bifur-client/pull/38) [`4f531d0`](https://github.com/sanity-io/bifur-client/commit/4f531d02486781a29eb2d1b4547927a43df97134) Thanks [@stipsan](https://github.com/stipsan)! - Hold the shared connection open for a 5s wall-clock grace period after the last subscriber leaves, instead of one task-queue tick. Measurements on real studio boots ([sanity#14152](https://github.com/sanity-io/sanity/pull/14152)) showed that no fixed-tick notifier can bridge the gap between react-rx's render-phase unsubscribe and React's passive-effect resubscribe under load, so the task-based delay still churned 2–3 sockets per boot.

## 2.0.1

### Patch Changes

- [#36](https://github.com/sanity-io/bifur-client/pull/36) [`bffbbc6`](https://github.com/sanity-io/bifur-client/commit/bffbbc6a74af09bfaa779b4515b6296947c19974) Thanks [@stipsan](https://github.com/stipsan)! - Republish with npm trusted publishing so 2.0.1 includes provenance.

## 2.0.0

### Major Changes

- [#33](https://github.com/sanity-io/bifur-client/pull/33) [`43e5ab2`](https://github.com/sanity-io/bifur-client/commit/43e5ab2f388c5e2ad3f3717b6674cbfd5e3eaf78) Thanks [@renovate](https://github.com/apps/renovate)! - The minimum supported Node.js version is now 22.12 (previously 20.19).
  update dependency nanoid to v6

  Fixes the `WebSocket is closed before the connection is established` warning on every studio load.

  - A socket that is still connecting is never closed mid-handshake
  - The shared connection survives quick unsubscribe/resubscribe gaps (like react-rx's `useObservable` mount churn) — it connects once and stays connected
  - `WebSocketError` is now exported
