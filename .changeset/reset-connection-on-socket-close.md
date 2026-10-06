---
'@sanity/bifur-client': patch
---

Fix requests being sent on a closed WebSocket.

After `beforeunload`, requests could be sent on the closed socket if the page stayed open, for example after a cancelled unload prompt or a restore from the back/forward cache. The browser logged "WebSocket is already in CLOSING or CLOSED state", the requests never settled, and `heartbeats` kept reporting a live connection.

- `request()` and `listen()` now error with a `WebSocketError` of type `CONNECTION_CLOSED` when the socket isn't open, instead of sending.
- When the socket closes while it's still in use, `heartbeats`, and any requests and subscriptions still waiting for a reply, error with a `WebSocketError` of type `CONNECTION_CLOSED` that carries the close `code` and `reason`. The next request opens a new socket. Unsubscribing never causes this error.
