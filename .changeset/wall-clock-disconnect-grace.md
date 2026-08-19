---
'@sanity/bifur-client': patch
---

Hold the shared connection open for a 5s wall-clock grace period after the last subscriber leaves, instead of one task-queue tick. Measurements on real studio boots ([sanity#14152](https://github.com/sanity-io/sanity/pull/14152)) showed that no fixed-tick notifier can bridge the gap between react-rx's render-phase unsubscribe and React's passive-effect resubscribe under load, so the task-based delay still churned 2–3 sockets per boot.
