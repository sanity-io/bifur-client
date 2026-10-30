---
'@sanity/bifur-client': minor
---

Add a `closeOn` option to `fromUrl` and `fromSanityClient`. When the observable emits, the socket is closed (code 1000) without waiting for `idleTimeout`. `heartbeats`, pending requests and active `listen()` subscriptions error with a `WebSocketError` of type `CONNECTION_CLOSED`, and the next subscriber opens a new socket. An emission while no connection is open does nothing. Before the socket closes, each active `listen()` sends its `_unsubscribe` request. The observable must not replay its last value, like a `BehaviorSubject` does: it's subscribed once per connection, so a replayed emission closes every new connection as soon as it opens.

For example, close the socket when the page enters the back/forward cache. An open socket would otherwise either be closed by the browser, which logs an error, or keep the page out of the cache:

```ts
const enteredBackForwardCache$ = fromEvent<PageTransitionEvent>(window, 'pagehide').pipe(
  filter((event) => event.persisted),
)

fromUrl(url, {auth, idleTimeout: 5_000, closeOn: enteredBackForwardCache$})
```

Anything that uses the client after `closeOn` has emitted opens a new connection, so make sure nothing does when you close for the back/forward cache.
