---
'@sanity/bifur-client': patch
---

`fromUrl` no longer closes the socket on `beforeunload`. The page doesn't always leave after that event: it stays when an "unsaved changes" prompt is cancelled, and it can come back from the back/forward cache. The browser closes the socket itself when the page is unloaded.
