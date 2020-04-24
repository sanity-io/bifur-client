import {tap} from 'rxjs/operators'
import {fromUrl} from '../src'

const connection = fromUrl('wss://ppsg7ml5.api.sanity.io/v1/socket/test')

connection.heartbeat$.subscribe()
const sub = connection.stream('presence').pipe(tap(console.log)).subscribe()
// connection.request('presence_rollcall').pipe(tap(console.log)).subscribe()

setTimeout(() => {
  sub.unsubscribe()
}, 1000)
// connection.stream('presence').pipe(tap(console.log)).subscribe()
