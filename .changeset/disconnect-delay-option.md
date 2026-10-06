---
'@sanity/bifur-client': major
---

`fromUrl` now closes the socket as soon as its last subscriber leaves. Before, it kept the socket open for 5 seconds, which left a timer pending and could keep a runtime such as Node.js from exiting. To keep the old behavior, pass `disconnectDelay`:

```ts
fromUrl(url, {disconnectDelay: 5_000})
```

A delay reuses the socket across short gaps between subscribers, for example when React unmounts one component and mounts another that uses the same client.
