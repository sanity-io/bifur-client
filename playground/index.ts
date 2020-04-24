import {tap} from 'rxjs/operators'
import {createClient} from '../src/messages'

const connection = createClient('wss://ppsg7ml5.api.sanity.io/v1/socket/test')

connection.heartbeat$.subscribe()
connection.stream('presence').pipe(tap(console.log)).subscribe()
connection.request('presence_rollcall').pipe(tap(console.log)).subscribe()
