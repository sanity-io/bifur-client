---
'@sanity/bifur-client': major
---

`fromUrl` and `fromSanityClient` now close the socket as soon as the last subscriber leaves. Before, they kept it open for 5 seconds, which left a timer pending and could keep a runtime such as Node.js from exiting. To keep the old behavior, pass the new `idleTimeout` option:

```ts
fromUrl(url, {idleTimeout: 5_000})
fromSanityClient(client, {idleTimeout: 5_000})
```

A delay reuses the socket across short gaps between subscribers, for example when React unmounts one component and mounts another that uses the same client, or when react-rx's `useObservable` resubscribes from an effect after unsubscribing during render.

To decide each time, pass a function instead of a number. It's called whenever the last subscriber leaves, and the socket closes when the observable it returns emits:

```ts
fromUrl(url, {
  idleTimeout: () => (document.visibilityState === 'hidden' ? of(0) : timer(5_000)),
})
```
