# @sanity/bifur-client

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
