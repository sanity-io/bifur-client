---
'@sanity/bifur-client': patch
---

Fix requests being sent on a closed WebSocket.

`fromUrl` closed the socket on `beforeunload`, but the page doesn't always leave after that event: it stays when an "unsaved changes" prompt is cancelled, and it can come back from the back/forward cache. Requests on such a page were then sent on the closed socket. The browser logged "WebSocket is already in CLOSING or CLOSED state", the requests never settled, and `heartbeats` kept reporting a live connection.

- `fromUrl` no longer closes the socket on `beforeunload`. The browser closes it itself when the page is unloaded.
- `request()` and `listen()` no longer send on a socket that isn't open. They error with a `WebSocketError` of type `CONNECTION_CLOSED` once it has closed.
- When the socket closes while it's still in use, `heartbeats`, and any requests and subscriptions still waiting for a reply, error with a `WebSocketError` of type `CONNECTION_CLOSED` that carries the close `code` and `reason`. The next request opens a new socket. A close because the last subscriber left never causes this error.
- `token$` is now subscribed on each new socket, once it is open, so it must replay its latest value to new subscribers (a `BehaviorSubject`, or `shareReplay`). This was already needed for the token to be used after a reconnect; it is now documented.
