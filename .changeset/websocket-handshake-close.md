---
"@sanity/bifur-client": patch
---

Fixes the `WebSocket is closed before the connection is established` warning on every studio load.

- A socket that is still connecting is never closed mid-handshake
- The shared connection survives quick unsubscribe/resubscribe gaps (like react-rx's `useObservable` mount churn) — it connects once and stays connected
- `WebSocketError` is now exported
