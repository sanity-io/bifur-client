# @sanity/bifur-client

## 1.0.0

### Major Changes

- [#30](https://github.com/sanity-io/bifur-client/pull/30) [`fd7c51f`](https://github.com/sanity-io/bifur-client/commit/fd7c51fdb847341d905bc60335762b131d93775b) Thanks [@stipsan](https://github.com/stipsan)! - The minimum supported Node.js version is now 22.12 (previously 20.19).

### Patch Changes

- [#30](https://github.com/sanity-io/bifur-client/pull/30) [`fd7c51f`](https://github.com/sanity-io/bifur-client/commit/fd7c51fdb847341d905bc60335762b131d93775b) Thanks [@stipsan](https://github.com/stipsan)! - Fixes the `WebSocket is closed before the connection is established` warning on every studio load.

  - A socket that is still connecting is never closed mid-handshake
  - The shared connection survives quick unsubscribe/resubscribe gaps (like react-rx's `useObservable` mount churn) — it connects once and stays connected
  - `WebSocketError` is now exported
