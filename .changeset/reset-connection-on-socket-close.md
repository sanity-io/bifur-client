---
'@sanity/bifur-client': patch
---

Fix requests being sent on a closed WebSocket.

After `beforeunload`, requests could be sent on the closed socket if the page stayed open, for example after a cancelled unload prompt or a restore from the back/forward cache. The browser logged "WebSocket is already in CLOSING or CLOSED state", the requests never settled, and `heartbeats` kept reporting a live connection.

- `request()` and `listen()` no longer send on a socket that isn't open. They error with a `WebSocketError` of type `CONNECTION_CLOSED` once it has closed.
- When the socket closes while it's still in use, `heartbeats`, and any requests and subscriptions still waiting for a reply, error with a `WebSocketError` of type `CONNECTION_CLOSED` that carries the close `code` and `reason`. The next request opens a new socket. A close because the last subscriber left never causes this error.
