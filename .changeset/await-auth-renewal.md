---
'@sanity/bifur-client': minor
---

Add an `auth` option to `createClient` and `fromUrl`: an observable of promises that resolve to the connection's credentials (`{token}`, or `undefined` for none). Emit a promise when a token renewal starts. Requests wait for it to resolve, and the open socket is then authorized with the new token without reconnecting, so no request goes out with a token that is about to be replaced. A rejected promise errors the connection. The observable must replay its latest emission to new subscribers, like a `BehaviorSubject`.

```ts
const auth = new BehaviorSubject<Promise<Auth | undefined>>(Promise.resolve({token}))
const client = fromUrl(url, {auth})

// on renewal
auth.next(renewToken().then((token) => ({token})))
```

`token$` is deprecated in favor of `auth`, and can't be combined with it.
