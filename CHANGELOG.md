# @sanity/bifur-client

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
