---
'@sanity/bifur-client': major
---

Add an `auth` option to `createClient`, `fromUrl` and `fromSanityClient`: an observable of promises that resolve to the connection's credentials. A promise can resolve to `{token}`, to `{withCredentials: true}` for cookies, or to `undefined` for no credentials. With cookies, the client sends no token, and the browser sends the cookies with the WebSocket handshake. The observable must replay its latest emission to new subscribers, like a `BehaviorSubject`. Without `auth`, `fromSanityClient` still authorizes with the client's token, and it now accepts all the options `fromUrl` does.

Emit a new promise when a token renewal starts. Requests wait until the promise resolves and the open socket is authorized with the new token, then they are sent, so requests made during a renewal use the new token. A rejected promise errors the connection, and every new request fails the same way until `auth` emits a new promise, so don't retry before the credentials are renewed. When the credentials switch from a token to cookies or none, for example on logout, the client closes the socket. Requests waiting at that moment, or made before the socket has closed, fail with a `WebSocketError` of type `CONNECTION_CLOSED`, and the next request opens a new socket without the token. A socket waiting out `idleTimeout` still follows `auth`: a renewed token is sent to it, and a dropped token closes it right away.

```ts
const auth = new BehaviorSubject<Promise<Auth | undefined>>(Promise.resolve({token}))
const client = fromUrl(url, {auth})

// on renewal, with your own function that resolves to the new token
auth.next(renewToken().then((token) => ({token})))
```

`request()` and `listen()` now fail with an `RpcError`, which carries the JSON-RPC error `code`, when the server replies with an error. Before, they emitted `undefined`. A rejected `authorization` request therefore errors the connection instead of letting requests go out unauthorized.

**Breaking:** `token$` is removed. Wrap an existing token observable to migrate:

```ts
import {map} from 'rxjs'

fromUrl(url, {auth: token$.pipe(map((token) => Promise.resolve(token ? {token} : undefined)))})
```

After migrating, a `null` token that follows a token closes the socket, so the next request connects without it.
